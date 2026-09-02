import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	aliasKey,
	deleteAlias,
	getAlias,
	getDomain,
	getLog,
	getLogs,
	listAliases,
	listDestinations,
	listDomains,
	listTags,
	logKey,
	putAlias,
	putDestination,
	putDomain,
	putGlobalSenderBlocklist,
	putTag
} from '../../src/lib/kv.js';
import { KV_BULK_GET_LIMIT } from '../../src/lib/kv-batch.js';
import { appendLog } from '../src/index.js';
import { MemoryKV, asKV, makeAlias, makeDomain, readAlias, runEmail } from './helpers.js';

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * These tests pin the storage contract shared by the dashboard (which writes via
 * `src/lib/kv.ts`) and the mail worker (which reads hard-coded keys in
 * `email-worker/src/index.ts`). A drift between the two silently drops mail, so
 * the exact key strings are asserted here.
 */
describe('KV key formats match the worker', () => {
	it('uses the exact alias key the worker reads', () => {
		expect(aliasKey('aliases.example.com', 'orders')).toBe('alias:aliases.example.com/orders');
	});

	it('uses the exact log key the worker writes', () => {
		expect(logKey('aliases.example.com', 'orders')).toBe('log:aliases.example.com/orders');
	});

	it('writes the domain under the worker key', async () => {
		const kv = new MemoryKV();
		await putDomain(asKV(kv), makeDomain());
		expect(kv.store.has('domain:aliases.example.com')).toBe(true);
	});

	it('writes the global blocklist under the settings key the worker reads', async () => {
		const kv = new MemoryKV();
		await putGlobalSenderBlocklist(asKV(kv), {
			blockedSenderAddresses: ['spam@example.com'],
			blockedSenderDomains: []
		});
		expect(kv.store.has('settings:sender-blocklist')).toBe(true);
	});

	it('reads back a log the worker wrote via appendLog', async () => {
		const kv = new MemoryKV();
		await appendLog(asKV(kv), 'aliases.example.com', 'orders', {
			at: 1,
			action: 'forwarded',
			from: 'sender@example.com',
			to: 'inbox@example.net'
		});
		const log = await getLog(asKV(kv), 'aliases.example.com', 'orders');
		expect(log).toHaveLength(1);
		expect(log[0].action).toBe('forwarded');
	});

	it('decodes encoded-word subjects written before subjects were decoded', async () => {
		const kv = new MemoryKV();
		kv.store.set(
			'log:aliases.example.com/orders',
			JSON.stringify([
				{
					at: 1,
					action: 'forwarded',
					from: 'sender@example.com',
					to: 'inbox@example.net',
					subject: '=?UTF-8?B?5LiW55WM?='
				}
			])
		);
		const log = await getLog(asKV(kv), 'aliases.example.com', 'orders');
		expect(log[0].subject).toBe('世界');
	});

	it('reads a log entry whose subject is not a string without throwing', async () => {
		const kv = new MemoryKV();
		kv.store.set(
			'log:aliases.example.com/orders',
			JSON.stringify([
				{ at: 1, action: 'forwarded', from: 'sender@example.com', to: 'inbox@example.net', subject: 42 }
			])
		);
		const log = await getLog(asKV(kv), 'aliases.example.com', 'orders');
		expect(log).toHaveLength(1);
		expect(log[0].subject).toBe(42 as unknown as string);
	});

	it('ignores malformed and non-array historical logs', async () => {
		const kv = new MemoryKV();
		kv.store.set(logKey('aliases.example.com', 'broken'), '{');
		kv.store.set(logKey('aliases.example.com', 'object'), JSON.stringify({ at: 1 }));

		expect(await getLog(asKV(kv), 'aliases.example.com', 'broken')).toEqual([]);
		expect(await getLog(asKV(kv), 'aliases.example.com', 'object')).toEqual([]);
	});
});

describe('end-to-end: dashboard writes → worker delivers', () => {
	it('forwards mail for an alias created through the dashboard helpers', async () => {
		const kv = new MemoryKV();
		await putDomain(asKV(kv), makeDomain());
		await putAlias(asKV(kv), makeAlias({ targetEmail: 'me@personal.example' }));

		const { forward, setReject } = await runEmail({ kv, domain: null, alias: null });
		expect(setReject).not.toHaveBeenCalled();
		expect(forward).toHaveBeenCalledWith('me@personal.example');
	});

	it('blocks mail when the dashboard writes a global blocklist entry', async () => {
		const kv = new MemoryKV();
		await putDomain(asKV(kv), makeDomain());
		await putAlias(asKV(kv), makeAlias());
		await putGlobalSenderBlocklist(asKV(kv), {
			blockedSenderAddresses: [],
			blockedSenderDomains: ['evil.example']
		});

		const { forward } = await runEmail({
			kv,
			domain: null,
			alias: null,
			from: 'attacker@evil.example'
		});
		expect(forward).not.toHaveBeenCalled();
		expect(readAlias(kv).blockedCount).toBe(1);
	});

	it('stops forwarding once the dashboard disables the alias', async () => {
		const kv = new MemoryKV();
		await putDomain(asKV(kv), makeDomain());
		await putAlias(asKV(kv), makeAlias({ enabled: false }));

		const { forward, setReject } = await runEmail({ kv, domain: null, alias: null });
		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Message rejected');
	});
});

describe('dashboard round-trips through KV', () => {
	it('round-trips a domain and lists it', async () => {
		const kv = new MemoryKV();
		await putDomain(asKV(kv), makeDomain());
		expect(await getDomain(asKV(kv), 'aliases.example.com')).toMatchObject({
			domain: 'aliases.example.com'
		});
		expect(await listDomains(asKV(kv))).toHaveLength(1);
	});

	it('round-trips, lists, and deletes an alias', async () => {
		const kv = new MemoryKV();
		await putAlias(asKV(kv), makeAlias());
		expect(await getAlias(asKV(kv), 'aliases.example.com', 'orders')).toMatchObject({
			localPart: 'orders'
		});
		expect(await listAliases(asKV(kv), 'aliases.example.com')).toHaveLength(1);

		await deleteAlias(asKV(kv), 'aliases.example.com', 'orders');
		expect(await getAlias(asKV(kv), 'aliases.example.com', 'orders')).toBeNull();
	});

	it('scopes alias listing to the requested domain prefix', async () => {
		const kv = new MemoryKV();
		await putAlias(asKV(kv), makeAlias({ domain: 'a.example.com', localPart: 'one' }));
		await putAlias(asKV(kv), makeAlias({ domain: 'b.example.com', localPart: 'two' }));
		const listed = await listAliases(asKV(kv), 'a.example.com');
		expect(listed).toHaveLength(1);
		expect(listed[0].localPart).toBe('one');
	});

	it('lists aliases with bulk reads capped at the KV bulk-get limit', async () => {
		const kv = new MemoryKV();
		for (let i = 0; i < 205; i++) {
			const alias = makeAlias({ localPart: `alias-${i}` });
			kv.store.set(aliasKey(alias.domain, alias.localPart), JSON.stringify(alias));
		}

		expect(await listAliases(asKV(kv), 'aliases.example.com')).toHaveLength(205);
		expect(kv.getCalls.filter(Array.isArray).map((keys) => keys.length)).toEqual([
			KV_BULK_GET_LIMIT,
			KV_BULK_GET_LIMIT,
			205 - 2 * KV_BULK_GET_LIMIT
		]);
		expect(kv.getCalls.some((key) => typeof key === 'string')).toBe(false);
	});

	it('follows list cursors beyond the first 1,000 keys', async () => {
		const kv = new MemoryKV();
		for (let i = 0; i < 1_005; i++) {
			const alias = makeAlias({ localPart: `alias-${i}` });
			kv.store.set(aliasKey(alias.domain, alias.localPart), JSON.stringify(alias));
		}

		const listed = await listAliases(asKV(kv), 'aliases.example.com');
		expect(listed).toHaveLength(1_005);
		expect(new Set(listed.map((alias) => alias.localPart)).size).toBe(1_005);
	});

	it('bulk-reads logs in batches and preserves alias order', async () => {
		const kv = new MemoryKV();
		const aliases = Array.from({ length: 101 }, (_, index) =>
			makeAlias({ localPart: `alias-${(index * 37) % 101}` })
		);
		for (const alias of aliases) {
			const sequence = Number(alias.localPart.slice('alias-'.length));
			kv.store.set(
				logKey(alias.domain, alias.localPart),
				JSON.stringify([{ at: sequence, action: 'forwarded', from: 'sender@example.com' }])
			);
		}

		kv.resetGetCalls();
		const logs = await getLogs(asKV(kv), aliases);
		expect(logs).toHaveLength(101);
		expect(logs.map((log) => log[0].at)).toEqual(
			aliases.map((alias) => Number(alias.localPart.slice('alias-'.length)))
		);
		expect(kv.getCalls.filter(Array.isArray).map((keys) => keys.length)).toEqual([100, 1]);
	});

	it('round-trips destinations and tags', async () => {
		const kv = new MemoryKV();
		await putDestination(asKV(kv), { email: 'me@example.net', createdAt: 1 });
		await putTag(asKV(kv), { name: 'shopping', color: '#64D864', createdAt: 1 });
		expect(await listDestinations(asKV(kv))).toHaveLength(1);
		expect(await listTags(asKV(kv))).toHaveLength(1);
	});
});
