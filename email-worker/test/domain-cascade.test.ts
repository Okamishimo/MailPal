import { describe, expect, it } from 'vitest';
import {
	deleteDomainCascade,
	MAX_CASCADE_DELETES
} from '../../src/lib/server/domain-cascade.js';
import { aliasKey, logKey } from '../../src/lib/kv.js';
import type { DomainConfig } from '../../src/lib/types.js';
import { MemoryKV, asKV, makeAlias, makeDomain } from './helpers.js';

function seedDomain(kv: MemoryKV, aliasCount: number): void {
	const domain = makeDomain();
	kv.store.set(`domain:${domain.domain}`, JSON.stringify(domain));
	for (let index = 0; index < aliasCount; index++) {
		const alias = makeAlias({ localPart: `alias-${index}` });
		kv.store.set(aliasKey(alias.domain, alias.localPart), JSON.stringify(alias));
		kv.store.set(
			logKey(alias.domain, alias.localPart),
			JSON.stringify([{ at: 1, action: 'forwarded', from: 'sender@example.com' }])
		);
	}
}

describe('domain cascade deletion', () => {
	it('keeps a disabled domain handle and reads only one bounded alias page', async () => {
		const kv = new MemoryKV();
		seedDomain(kv, 1_001);

		const result = await deleteDomainCascade(asKV(kv), 'aliases.example.com');

		expect(result).toEqual({ found: true, complete: false });
		expect(JSON.parse(kv.store.get('domain:aliases.example.com')!) as DomainConfig).toMatchObject({
			enabled: false
		});
		expect(kv.listCalls).toEqual([
			{ prefix: 'alias:aliases.example.com/', cursor: undefined, limit: MAX_CASCADE_DELETES + 1 }
		]);
		expect(kv.getCalls.filter(Array.isArray)).toHaveLength(0);
		const aliasDeletes = kv.mutationCalls.filter((call) => call.key.startsWith('alias:'));
		expect(aliasDeletes).toHaveLength(MAX_CASCADE_DELETES);
	});

	it('deletes the domain only after the final alias page', async () => {
		const kv = new MemoryKV();
		seedDomain(kv, MAX_CASCADE_DELETES + 1);

		expect(await deleteDomainCascade(asKV(kv), 'aliases.example.com')).toEqual({
			found: true,
			complete: false
		});
		expect(kv.store.has('domain:aliases.example.com')).toBe(true);

		expect(await deleteDomainCascade(asKV(kv), 'aliases.example.com')).toEqual({
			found: true,
			complete: true
		});
		expect(kv.store.has('domain:aliases.example.com')).toBe(false);
		expect([...kv.store.keys()].some((key) => key.startsWith('alias:'))).toBe(false);
	});

	it('never mutates the domain key twice in one request', async () => {
		const kv = new MemoryKV();
		seedDomain(kv, 5);

		await deleteDomainCascade(asKV(kv), 'aliases.example.com');

		// KV answers a second write to the same key within a second with a 429,
		// so the single-request path must not disable the domain before deleting.
		expect(kv.mutationCalls.filter((call) => call.key === 'domain:aliases.example.com')).toEqual([
			{ operation: 'delete', key: 'domain:aliases.example.com' }
		]);
	});

	it('stays inside the free-plan per-invocation operation budget', async () => {
		const kv = new MemoryKV();
		seedDomain(kv, MAX_CASCADE_DELETES + 1);

		await deleteDomainCascade(asKV(kv), 'aliases.example.com');

		const operations = kv.getCalls.length + kv.listCalls.length + kv.mutationCalls.length;
		expect(operations).toBeLessThan(1_000);
	});

	it('deletes each alias together with its activity log', async () => {
		const kv = new MemoryKV();
		seedDomain(kv, 5);

		expect(await deleteDomainCascade(asKV(kv), 'aliases.example.com')).toEqual({
			found: true,
			complete: true
		});
		// Orphaned logs are invisible in the UI but still consume the backup
		// entry budget, so they have to go with the alias.
		expect([...kv.store.keys()].filter((key) => key.startsWith('log:'))).toEqual([]);
	});

	it('leaves the domain disabled when an alias cleanup batch fails', async () => {
		class FailingAliasDeleteKV extends MemoryKV {
			private aliasDeleteCount = 0;

			override async delete(key: string): Promise<void> {
				if (key.startsWith('alias:') && this.aliasDeleteCount++ === 10) {
					throw new Error('simulated KV failure');
				}
				await super.delete(key);
			}
		}

		const kv = new FailingAliasDeleteKV();
		seedDomain(kv, MAX_CASCADE_DELETES + 1);

		await expect(deleteDomainCascade(asKV(kv), 'aliases.example.com')).rejects.toThrow(
			'simulated KV failure'
		);
		expect(JSON.parse(kv.store.get('domain:aliases.example.com')!) as DomainConfig).toMatchObject({
			enabled: false
		});
	});
});
