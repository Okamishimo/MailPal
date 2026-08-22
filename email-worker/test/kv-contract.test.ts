import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	aliasKey,
	deleteAlias,
	getAlias,
	getDomain,
	getLog,
	listAliases,
	listDestinations,
	listDomains,
	listTags,
	putAlias,
	putDestination,
	putDomain,
	putGlobalSenderBlocklist,
	putTag
} from '../../src/lib/kv.js';
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

	it('round-trips destinations and tags', async () => {
		const kv = new MemoryKV();
		await putDestination(asKV(kv), { email: 'me@example.net', createdAt: 1 });
		await putTag(asKV(kv), { name: 'shopping', color: '#64D864', createdAt: 1 });
		expect(await listDestinations(asKV(kv))).toHaveLength(1);
		expect(await listTags(asKV(kv))).toHaveLength(1);
	});
});
