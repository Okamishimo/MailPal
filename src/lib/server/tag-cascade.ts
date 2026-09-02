import type { KVNamespace } from '@cloudflare/workers-types';
import { KV_BULK_GET_LIMIT, chunk, getMany, runInBatches } from '../kv-batch.js';
import {
	ALIAS_PREFIX,
	CASCADE_PREFIX,
	deleteTag,
	parseTag,
	putAlias,
	putTag,
	tagKey
} from '../kv.js';
import type { AliasConfig } from '../types.js';

export const MAX_CASCADE_UPDATES = 800;
const TAG_CASCADE_PREFIX = `${CASCADE_PREFIX}tag:`;
// An abandoned cascade must not keep a stale cursor around forever: KV can
// reject a cursor long after it was issued, and without an expiry that would
// leave the tag permanently undeletable.
const CASCADE_MARKER_TTL_SECONDS = 24 * 60 * 60;

interface TagCascadeProgress {
	cursor?: string;
}

export interface TagCascadeResult {
	found: boolean;
	complete: boolean;
}

function progressKey(name: string): string {
	return `${TAG_CASCADE_PREFIX}${name}`;
}

function parseProgress(value: string | null): TagCascadeProgress | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as TagCascadeProgress;
		return typeof parsed.cursor === 'string' ? { cursor: parsed.cursor } : {};
	} catch {
		// A malformed marker is safe to restart: alias updates are idempotent.
		return {};
	}
}

type AliasPage = Awaited<ReturnType<KVNamespace['list']>>;

async function listAliasPage(kv: KVNamespace, cursor?: string): Promise<AliasPage> {
	const options = { prefix: ALIAS_PREFIX, limit: MAX_CASCADE_UPDATES };
	if (!cursor) return kv.list(options);
	try {
		return await kv.list({ ...options, cursor });
	} catch {
		// A persisted cursor can be rejected once it has expired. Restarting the
		// scan costs one extra pass but keeps the tag deletable; throwing here
		// would wedge it forever, since nothing else clears the stored cursor.
		return kv.list(options);
	}
}

/**
 * Scan one bounded page of aliases and persist the continuation cursor. The tag
 * definition remains visible until every page has been processed — flagged
 * `pendingDelete` so it reads as "clearing up" and stops being offered for
 * assignment — and the caller keeps calling until `complete` comes back true.
 */
export async function deleteTagCascade(
	kv: KVNamespace,
	name: string
): Promise<TagCascadeResult> {
	const markerKey = progressKey(name);
	const [existing, storedProgress] = await Promise.all([
		kv.get(tagKey(name)),
		kv.get(markerKey)
	]);
	const progress = parseProgress(storedProgress);
	if (!existing && !progress) return { found: false, complete: true };

	const page = await listAliasPage(kv, progress?.cursor);

	// Read and rewrite one bulk-read batch at a time. KV has no compare-and-set,
	// so every alias update is a read-modify-write over the whole record —
	// interleaving keeps that window as short as the batch instead of spanning
	// the entire page.
	for (const batch of chunk(page.keys.map((key) => key.name), KV_BULK_GET_LIMIT)) {
		const values = await getMany(kv, batch);
		const affected = batch.flatMap((key) => {
			const value = values.get(key);
			if (!value) return [];
			try {
				const alias = JSON.parse(value) as AliasConfig;
				return alias.tags?.includes(name) ? [alias] : [];
			} catch {
				// One unreadable alias must not wedge the whole cascade.
				return [];
			}
		});

		await runInBatches(affected, (alias) =>
			putAlias(kv, {
				...alias,
				tags: alias.tags?.filter((tag) => tag !== name)
			})
		);
	}

	if (!page.list_complete) {
		// Flag the tag before handing control back to the client: it stays
		// visible as a retry handle, but the UI stops offering it for assignment
		// so no alias can be tagged behind the advancing cursor.
		const tag = parseTag(existing);
		if (tag && !tag.pendingDelete) await putTag(kv, { ...tag, pendingDelete: true });

		// Written only once the scan is known to be incomplete — a run that never
		// returns 202 has nothing to resume from, and the retry is idempotent.
		await kv.put(markerKey, JSON.stringify({ cursor: page.cursor } satisfies TagCascadeProgress), {
			expirationTtl: CASCADE_MARKER_TTL_SECONDS
		});
		return { found: true, complete: false };
	}

	// Remove the progress marker first. If deleting the definition then fails,
	// the visible tag remains and a retry safely restarts the bounded scan.
	if (storedProgress) await kv.delete(markerKey);
	if (existing) await deleteTag(kv, name);
	return { found: true, complete: true };
}
