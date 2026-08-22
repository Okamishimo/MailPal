import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { appendLog, handleFetch } from '../src/index.js';
import {
	MemoryKV,
	asKV,
	makeAlias,
	makeDomain,
	readAlias,
	readLog,
	runEmail
} from './helpers.js';

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('HTTP surface', () => {
	it('returns an empty 404 for HTTP requests so nothing is exposed over the URL', async () => {
		const res = await handleFetch();
		expect(res.status).toBe(404);
		expect(await res.text()).toBe('');
	});
});

describe('envelope recipient parsing', () => {
	it.each([
		['no @ sign', 'orders.aliases.example.com'],
		['leading @', '@aliases.example.com'],
		['trailing @', 'orders@'],
		['two @ signs', 'orders@x@aliases.example.com'],
		['empty string', '']
	])('rejects a %s recipient without forwarding or logging', async (_label, to) => {
		const { forward, setReject, kv } = await runEmail({ to });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Address unavailable');
		expect(kv.store.has('log:aliases.example.com/orders')).toBe(false);
	});

	it('lowercases and trims the recipient before routing', async () => {
		const { forward, setReject } = await runEmail({ to: '  Orders@Aliases.Example.COM  ' });
		expect(setReject).not.toHaveBeenCalled();
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
	});
});

describe('domain and alias resolution', () => {
	it('rejects mail for an unknown domain', async () => {
		const { forward, setReject } = await runEmail({ domain: null });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Address unavailable');
	});

	it('rejects mail for a disabled domain', async () => {
		const { forward, setReject } = await runEmail({ domain: makeDomain({ enabled: false }) });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Address unavailable');
	});

	it('rejects an unknown alias when wildcard is disabled', async () => {
		const { forward, setReject, kv } = await runEmail({ alias: null });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Address unavailable');
		// An unknown alias must not create any persisted state.
		expect(kv.store.has('alias:aliases.example.com/orders')).toBe(false);
	});

	it('auto-creates and persists a wildcard alias under the expected key', async () => {
		const { kv, forward } = await runEmail({
			alias: null,
			domain: makeDomain({ wildcardEnabled: true }),
			to: 'brand-new@aliases.example.com'
		});
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
		const created = readAlias(kv, 'brand-new');
		expect(created).toMatchObject({
			localPart: 'brand-new',
			domain: 'aliases.example.com',
			autoCreated: true,
			enabled: true,
			forwardedCount: 1
		});
	});
});

describe('forwarding behavior', () => {
	it('prefers the alias target over the domain target when set', async () => {
		const { forward } = await runEmail({
			alias: makeAlias({ targetEmail: 'personal@example.org' })
		});
		expect(forward).toHaveBeenCalledWith('personal@example.org');
	});

	it('falls back to the domain target when the alias target is null', async () => {
		const { forward } = await runEmail({ alias: makeAlias({ targetEmail: null }) });
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
	});

	it('increments forwardedCount, sets lastUsedAt, and records a forwarded log entry', async () => {
		const before = Date.now();
		const { kv } = await runEmail({ subject: 'Your receipt' });
		const alias = readAlias(kv);
		expect(alias.forwardedCount).toBe(1);
		expect(alias.lastUsedAt).toBeGreaterThanOrEqual(before);
		const entry = readLog(kv)[0];
		expect(entry).toMatchObject({
			action: 'forwarded',
			from: 'sender@example.com',
			to: 'inbox@example.net',
			recipient: 'orders@aliases.example.com',
			subject: 'Your receipt'
		});
		expect(entry.reason).toBeUndefined();
	});

	it('treats a null maxForwards as unlimited', async () => {
		const { forward } = await runEmail({
			alias: makeAlias({ forwardedCount: 9999, maxForwards: undefined })
		});
		expect(forward).toHaveBeenCalledOnce();
	});

	it('forwards while below the forwarding limit and increments the counter', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ forwardedCount: 1, maxForwards: 3 })
		});
		expect(forward).toHaveBeenCalledOnce();
		expect(readAlias(kv).forwardedCount).toBe(2);
	});

	it('forwards when the expiry is still in the future', async () => {
		const { forward } = await runEmail({
			alias: makeAlias({ expiresAt: Date.now() + 60_000 })
		});
		expect(forward).toHaveBeenCalledOnce();
	});
});

describe('blocking behavior and counters', () => {
	it('increments blockedCount (not forwardedCount) and keeps the alias enabled on a sender block', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ blockedSenderDomains: ['example.com'] }),
			from: 'spam@example.com'
		});
		expect(forward).not.toHaveBeenCalled();
		const alias = readAlias(kv);
		expect(alias.blockedCount).toBe(1);
		expect(alias.forwardedCount).toBe(0);
		expect(alias.enabled).toBe(true);
		expect(alias.lastUsedAt).not.toBeNull();
	});

	it('disables the alias when the forwarding limit is reached', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ forwardedCount: 2, maxForwards: 2 })
		});
		expect(forward).not.toHaveBeenCalled();
		expect(readAlias(kv).enabled).toBe(false);
		expect(readLog(kv)[0].reason).toBe('forwarding_limit_reached');
	});

	it('disables the alias and records a stable reason when expired', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ expiresAt: Date.now() - 1 })
		});
		expect(forward).not.toHaveBeenCalled();
		expect(readAlias(kv).enabled).toBe(false);
		expect(readLog(kv)[0].reason).toBe('alias_expired');
	});

	it('blocks a disabled alias before evaluating sender rules', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({
				enabled: false,
				senderMode: 'allowlist',
				allowedSenderAddresses: ['sender@example.com']
			})
		});
		expect(forward).not.toHaveBeenCalled();
		expect(readLog(kv)[0].reason).toBe('alias_disabled');
	});
});

describe('resilience: mail must never silently vanish on internal errors', () => {
	it('rejects with an internal error and does not increment the counter when forward() throws', async () => {
		const { kv, setReject, forward } = await runEmail({
			forward: async () => {
				throw new Error('SMTP unavailable');
			}
		});
		expect(forward).toHaveBeenCalledOnce();
		expect(setReject).toHaveBeenCalledWith('Internal error');
		// Counter must not advance for mail that was never delivered.
		expect(readAlias(kv).forwardedCount).toBe(0);
	});

	it('rejects with an internal error on a malformed domain record', async () => {
		const { setReject, forward } = await runEmail({ rawDomain: '{not valid json' });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Internal error');
	});

	it('rejects with an internal error on a malformed alias record', async () => {
		const { setReject, forward } = await runEmail({ rawAlias: 'definitely-not-json' });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Internal error');
	});

	it('ignores a malformed global blocklist and still delivers mail', async () => {
		const { forward, setReject } = await runEmail({ rawGlobalBlocklist: '<<broken>>' });
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
		expect(setReject).not.toHaveBeenCalled();
	});
});

describe('appendLog resilience and bounds', () => {
	it('recovers from a corrupt existing log by starting fresh', async () => {
		const kv = new MemoryKV();
		kv.store.set('log:aliases.example.com/orders', 'corrupt-not-json');
		await appendLog(asKV(kv), 'aliases.example.com', 'orders', {
			at: 1,
			action: 'forwarded',
			from: 'sender@example.com',
			to: 'inbox@example.net'
		});
		expect(readLog(kv)).toHaveLength(1);
	});

	it('ignores a non-array historical log payload', async () => {
		const kv = new MemoryKV();
		kv.store.set('log:aliases.example.com/orders', JSON.stringify({ not: 'an array' }));
		await appendLog(asKV(kv), 'aliases.example.com', 'orders', {
			at: 2,
			action: 'blocked',
			from: 'x@example.com',
			to: 'inbox@example.net',
			reason: 'alias_sender_blocked'
		});
		const log = readLog(kv);
		expect(Array.isArray(log)).toBe(true);
		expect(log).toHaveLength(1);
	});

	it('keeps only the newest 50 entries, newest first', async () => {
		const kv = new MemoryKV();
		for (let at = 0; at < 60; at++) {
			await appendLog(asKV(kv) as KVNamespace, 'aliases.example.com', 'orders', {
				at,
				action: 'blocked',
				from: 'sender@example.com',
				to: 'inbox@example.net',
				reason: 'alias_sender_blocked'
			});
		}
		const log = readLog(kv);
		expect(log).toHaveLength(50);
		expect(log[0].at).toBe(59);
		expect(log.at(-1)?.at).toBe(10);
	});
});
