import type { KVNamespace } from '@cloudflare/workers-types';

export const KV_BULK_GET_LIMIT = 100;
const KV_WRITE_BATCH_SIZE = 25;
// A single invocation is capped at ~1,000 KV operations, and one page load can
// fan out across many domains, so bulk reads are windowed like the writes are.
const KV_READ_BATCH_CONCURRENCY = 4;

/** Split items into fixed-size groups, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		groups.push(items.slice(index, index + size));
	}
	return groups;
}

/** Read KV values in batches that respect Cloudflare's bulk-read limit. */
export async function getMany(
	kv: KVNamespace,
	keys: string[]
): Promise<Map<string, string | null>> {
	const batches = chunk([...new Set(keys)], KV_BULK_GET_LIMIT);

	const values = new Map<string, string | null>();
	for (const window of chunk(batches, KV_READ_BATCH_CONCURRENCY)) {
		const results = await Promise.all(window.map((batch) => kv.get(batch)));
		for (const result of results) {
			for (const [key, value] of result) values.set(key, value);
		}
	}
	return values;
}

/** List every key for a prefix, following Cloudflare KV cursors to completion. */
export async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
		keys.push(...page.keys.map((key) => key.name));
		if (page.list_complete !== false || !page.cursor) break;
		cursor = page.cursor;
	} while (cursor);

	return keys;
}

/** Limit concurrent KV mutations while preserving the input order between batches. */
export async function runInBatches<T>(
	items: T[],
	operation: (item: T) => Promise<void>
): Promise<void> {
	for (const batch of chunk(items, KV_WRITE_BATCH_SIZE)) {
		await Promise.all(batch.map(operation));
	}
}
