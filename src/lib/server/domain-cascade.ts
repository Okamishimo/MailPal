import type { KVNamespace } from '@cloudflare/workers-types';
import { runInBatches } from '../kv-batch.js';
import { aliasPrefix, deleteDomain, getDomain, logKey, putDomain } from '../kv.js';

// Free-plan Workers allow 1,000 subrequests to Cloudflare services per
// invocation, and every alias costs two deletes — the alias and its activity
// log — so a page has to stay well under half of that budget.
export const MAX_CASCADE_DELETES = 400;

export interface DomainCascadeResult {
	found: boolean;
	complete: boolean;
}

/**
 * Delete one bounded page of a domain's aliases. When more pages remain the
 * domain is disabled first and left in place as a durable retry handle, so the
 * caller keeps calling until `complete` comes back true.
 */
export async function deleteDomainCascade(
	kv: KVNamespace,
	domain: string
): Promise<DomainCascadeResult> {
	const prefix = aliasPrefix(domain);
	const [config, page] = await Promise.all([
		getDomain(kv, domain),
		kv.list({
			prefix,
			// The extra key tells us whether another bounded request is needed.
			limit: MAX_CASCADE_DELETES + 1
		})
	]);
	const aliasKeys = page.keys.slice(0, MAX_CASCADE_DELETES).map((key) => key.name);
	if (!config && aliasKeys.length === 0) return { found: false, complete: true };

	const complete = page.list_complete && page.keys.length <= MAX_CASCADE_DELETES;

	// Freeze the domain only when the cleanup will span requests. KV rejects a
	// second mutation of the same key within one second with a 429, so a delete
	// that finishes in this request must not write the domain key first — and it
	// does not need to: the key is gone before the request returns, and the
	// worker rejects mail for a domain it cannot find.
	if (!complete && config?.enabled) {
		await putDomain(kv, { ...config, enabled: false });
	}

	// Drop each alias together with its activity log, matching the single-alias
	// DELETE route — orphaned logs are invisible in the UI but still count
	// against the backup entry limit.
	await runInBatches(aliasKeys, async (key) => {
		const localPart = key.slice(prefix.length);
		await Promise.all([kv.delete(key), kv.delete(logKey(domain, localPart))]);
	});

	if (complete && config) await deleteDomain(kv, domain);

	return { found: true, complete };
}
