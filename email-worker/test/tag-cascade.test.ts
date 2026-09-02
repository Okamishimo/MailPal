import { describe, expect, it } from 'vitest';
import {
	deleteTagCascade,
	MAX_CASCADE_UPDATES
} from '../../src/lib/server/tag-cascade.js';
import { aliasKey } from '../../src/lib/kv.js';
import { KV_BULK_GET_LIMIT } from '../../src/lib/kv-batch.js';
import type { Tag } from '../../src/lib/types.js';
import { MemoryKV, asKV, makeAlias } from './helpers.js';

function seedTag(kv: MemoryKV, aliasCount: number, affected = true): void {
	kv.store.set('tag:shopping', JSON.stringify({ name: 'shopping', color: '#3b82f6' }));
	for (let index = 0; index < aliasCount; index++) {
		const alias = makeAlias({
			localPart: `alias-${index}`,
			...(affected && { tags: ['shopping'] })
		});
		kv.store.set(aliasKey(alias.domain, alias.localPart), JSON.stringify(alias));
	}
}

describe('tag cascade deletion', () => {
	it('keeps the tag and persists a cursor after one bounded alias page', async () => {
		const kv = new MemoryKV();
		seedTag(kv, 1_001);

		const first = await deleteTagCascade(asKV(kv), 'shopping');

		expect(first).toEqual({ found: true, complete: false });
		expect(kv.store.has('tag:shopping')).toBe(true);
		expect(JSON.parse(kv.store.get('cascade:tag:shopping')!)).toEqual({
			cursor: String(MAX_CASCADE_UPDATES)
		});
		expect(kv.listCalls).toEqual([
			{ prefix: 'alias:', cursor: undefined, limit: MAX_CASCADE_UPDATES }
		]);
		expect(kv.getCalls.filter(Array.isArray).map((keys) => keys.length)).toEqual(
			Array(MAX_CASCADE_UPDATES / KV_BULK_GET_LIMIT).fill(KV_BULK_GET_LIMIT)
		);
		expect(kv.mutationCalls.filter((call) => call.key.startsWith('alias:'))).toHaveLength(
			MAX_CASCADE_UPDATES
		);
	});

	it('flags the tag as pending so it cannot be assigned mid-cascade', async () => {
		const kv = new MemoryKV();
		seedTag(kv, MAX_CASCADE_UPDATES + 1);

		await deleteTagCascade(asKV(kv), 'shopping');

		expect(JSON.parse(kv.store.get('tag:shopping')!) as Tag).toMatchObject({
			name: 'shopping',
			pendingDelete: true
		});
	});

	it('resumes from the cursor and deletes the tag only after the final page', async () => {
		const kv = new MemoryKV();
		seedTag(kv, MAX_CASCADE_UPDATES + 1);

		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: false
		});
		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: true
		});
		expect(kv.listCalls[1]).toEqual({
			prefix: 'alias:',
			cursor: String(MAX_CASCADE_UPDATES),
			limit: MAX_CASCADE_UPDATES
		});
		expect(kv.store.has('tag:shopping')).toBe(false);
		expect(kv.store.has('cascade:tag:shopping')).toBe(false);
		const aliases = [...kv.store.entries()]
			.filter(([key]) => key.startsWith('alias:'))
			.map(([, value]) => JSON.parse(value) as { tags?: string[] });
		expect(aliases.every((alias) => !alias.tags?.includes('shopping'))).toBe(true);
	});

	it('writes no progress marker when one page covers everything', async () => {
		const kv = new MemoryKV();
		seedTag(kv, 10);

		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: true
		});
		expect(kv.mutationCalls.some((call) => call.key.startsWith('cascade:'))).toBe(false);
	});

	it('pages through a large unrelated alias dataset', async () => {
		const kv = new MemoryKV();
		seedTag(kv, MAX_CASCADE_UPDATES + 1, false);

		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: false
		});
		expect(kv.mutationCalls.filter((call) => call.key.startsWith('alias:'))).toHaveLength(0);
		expect(kv.store.has('tag:shopping')).toBe(true);
	});

	it('skips a malformed alias record instead of wedging the tag', async () => {
		const kv = new MemoryKV();
		seedTag(kv, 5);
		kv.store.set(aliasKey('aliases.example.com', 'alias-2'), '{not json');

		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: true
		});
		expect(kv.store.has('tag:shopping')).toBe(false);
		expect(kv.store.get(aliasKey('aliases.example.com', 'alias-2'))).toBe('{not json');
	});

	it('restarts the scan when a persisted cursor is rejected', async () => {
		class ExpiringCursorKV extends MemoryKV {
			rejectCursor = false;

			override async list(
				options: { prefix?: string; cursor?: string; limit?: number } = {}
			): ReturnType<MemoryKV['list']> {
				if (this.rejectCursor && options.cursor) throw new Error('invalid cursor');
				return super.list(options);
			}
		}

		const kv = new ExpiringCursorKV();
		seedTag(kv, MAX_CASCADE_UPDATES + 1);

		await deleteTagCascade(asKV(kv), 'shopping');
		kv.rejectCursor = true;

		// The rejected cursor must not surface as a 500 — that would leave the
		// stored cursor in place and make the tag permanently undeletable.
		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: false
		});
		expect(kv.listCalls.at(-1)).toEqual({
			prefix: 'alias:',
			cursor: undefined,
			limit: MAX_CASCADE_UPDATES
		});

		kv.rejectCursor = false;
		expect(await deleteTagCascade(asKV(kv), 'shopping')).toEqual({
			found: true,
			complete: true
		});
		expect(kv.store.has('tag:shopping')).toBe(false);
	});

	it('does not advance the cursor when an alias update fails', async () => {
		class FailingAliasPutKV extends MemoryKV {
			override async put(key: string, value: string): Promise<void> {
				if (key.startsWith('alias:')) throw new Error('simulated KV failure');
				await super.put(key, value);
			}
		}

		const kv = new FailingAliasPutKV();
		seedTag(kv, MAX_CASCADE_UPDATES + 1);

		await expect(deleteTagCascade(asKV(kv), 'shopping')).rejects.toThrow('simulated KV failure');
		expect(kv.store.has('tag:shopping')).toBe(true);
		// No marker yet: a run that never returned 202 has nothing to resume, and
		// restarting the bounded scan is idempotent.
		expect(kv.store.has('cascade:tag:shopping')).toBe(false);
	});
});
