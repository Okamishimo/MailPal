import type { KVNamespace } from '@cloudflare/workers-types';
import type {
	AliasConfig,
	DestinationAddress,
	DomainConfig,
	GlobalSenderBlocklist,
	LogEntry,
	Tag
} from './types.js';
import { getMany, listKeys } from './kv-batch.js';
import { normalizeGlobalSenderBlocklist, sanitizeSubject } from './sender-rules.js';

const GLOBAL_SENDER_BLOCKLIST_KEY = 'settings:sender-blocklist';

export const DOMAIN_PREFIX = 'domain:';
export const ALIAS_PREFIX = 'alias:';
export const LOG_PREFIX = 'log:';
export const TAG_PREFIX = 'tag:';
/** Transient resume state for multi-request cascade deletes; never exported in backups. */
export const CASCADE_PREFIX = 'cascade:';

async function listJsonValues<T>(kv: KVNamespace, prefix: string): Promise<T[]> {
	const keys = await listKeys(kv, prefix);
	const values = await getMany(kv, keys);
	return keys.flatMap((key) => {
		const value = values.get(key);
		if (!value) return [];
		try {
			const parsed = JSON.parse(value) as T | null;
			return parsed === null ? [] : [parsed];
		} catch {
			// Match the email worker: one malformed record must not take down a
			// whole page — that would hide the very UI needed to repair it.
			return [];
		}
	});
}

export function parseLog(value: string | null | undefined): LogEntry[] {
	let log: LogEntry[] = [];
	try {
		const parsed: unknown = value ? JSON.parse(value) : [];
		if (Array.isArray(parsed)) log = parsed as LogEntry[];
	} catch {
		// Match the email worker: malformed historical logs must not break a page.
	}
	// Entries written before subjects were decoded still hold RFC 2047
	// encoded-words, cut off at 200 characters of encoded text; decoding on read
	// keeps that history readable until the ring buffer ages those entries out.
	return log.map((entry) =>
		typeof entry.subject === 'string'
			? { ...entry, subject: sanitizeSubject(entry.subject, { recoverTruncated: true }) }
			: entry
	);
}

// ─── Domain helpers ───────────────────────────────────────────────────────────

export function domainKey(domain: string): string {
	return `${DOMAIN_PREFIX}${domain}`;
}

export async function getDomain(
	kv: KVNamespace,
	domain: string
): Promise<DomainConfig | null> {
	const val = await kv.get(domainKey(domain));
	return val ? (JSON.parse(val) as DomainConfig) : null;
}

export async function putDomain(kv: KVNamespace, config: DomainConfig): Promise<void> {
	await kv.put(domainKey(config.domain), JSON.stringify(config));
}

export async function deleteDomain(kv: KVNamespace, domain: string): Promise<void> {
	await kv.delete(domainKey(domain));
}

export async function listDomains(kv: KVNamespace): Promise<DomainConfig[]> {
	return listJsonValues<DomainConfig>(kv, DOMAIN_PREFIX);
}

// ─── Alias helpers ────────────────────────────────────────────────────────────

export function aliasKey(domain: string, localPart: string): string {
	return `${ALIAS_PREFIX}${domain}/${localPart}`;
}

/** Prefix matching every alias of one domain — `aliasKey` with an empty local part. */
export function aliasPrefix(domain: string): string {
	return aliasKey(domain, '');
}

export function logKey(domain: string, localPart: string): string {
	return `${LOG_PREFIX}${domain}/${localPart}`;
}

/**
 * The inverse of {@link logKey}.
 *
 * A domain never contains a slash, so the first one separates the two halves.
 * A local part may hold further slashes — they are valid unquoted atext, and
 * wildcard mode auto-creates whatever arrives — so splitting on the last slash
 * instead would reject those aliases. Returns null for a key that names no
 * alias at all, which is nothing the app itself writes.
 */
export function splitLogKey(key: string): { domain: string; localPart: string } | null {
	const suffix = key.slice(LOG_PREFIX.length);
	const slash = suffix.indexOf('/');
	if (slash <= 0 || slash === suffix.length - 1) return null;
	return { domain: suffix.slice(0, slash), localPart: suffix.slice(slash + 1) };
}

export async function getAlias(
	kv: KVNamespace,
	domain: string,
	localPart: string
): Promise<AliasConfig | null> {
	const val = await kv.get(aliasKey(domain, localPart));
	return val ? (JSON.parse(val) as AliasConfig) : null;
}

export async function putAlias(kv: KVNamespace, config: AliasConfig): Promise<void> {
	await kv.put(aliasKey(config.domain, config.localPart), JSON.stringify(config));
}

export async function deleteAlias(
	kv: KVNamespace,
	domain: string,
	localPart: string
): Promise<void> {
	await kv.delete(aliasKey(domain, localPart));
}

export async function listAliases(kv: KVNamespace, domain: string): Promise<AliasConfig[]> {
	return listJsonValues<AliasConfig>(kv, aliasPrefix(domain));
}

// ─── Destination address helpers ──────────────────────────────────────────────

export async function listDestinations(kv: KVNamespace): Promise<DestinationAddress[]> {
	return listJsonValues<DestinationAddress>(kv, 'destination:');
}

export async function putDestination(kv: KVNamespace, dest: DestinationAddress): Promise<void> {
	await kv.put(`destination:${dest.email}`, JSON.stringify(dest));
}

export async function deleteDestination(kv: KVNamespace, email: string): Promise<void> {
	await kv.delete(`destination:${email}`);
}

// ─── Activity log helpers ─────────────────────────────────────────────────────
//
// Reading activity lives in `server/activity.ts`, which merges these legacy
// `log:` keys with the D1 table. Only the key shape and the delete stay here,
// since the domain cascade and the alias DELETE route both need them.

export async function deleteLog(kv: KVNamespace, domain: string, localPart: string): Promise<void> {
	await kv.delete(logKey(domain, localPart));
}

// ─── Sender filtering settings ───────────────────────────────────────────────

export async function getGlobalSenderBlocklist(kv: KVNamespace): Promise<GlobalSenderBlocklist> {
	const val = await kv.get(GLOBAL_SENDER_BLOCKLIST_KEY);
	if (!val) return normalizeGlobalSenderBlocklist(null);
	try {
		return normalizeGlobalSenderBlocklist(JSON.parse(val));
	} catch {
		return normalizeGlobalSenderBlocklist(null);
	}
}

export async function putGlobalSenderBlocklist(
	kv: KVNamespace,
	blocklist: GlobalSenderBlocklist
): Promise<void> {
	await kv.put(GLOBAL_SENDER_BLOCKLIST_KEY, JSON.stringify(blocklist));
}

// ─── Tag helpers ──────────────────────────────────────────────────────────────

export function tagKey(name: string): string {
	return `${TAG_PREFIX}${name}`;
}

export async function listTags(kv: KVNamespace): Promise<Tag[]> {
	return listJsonValues<Tag>(kv, TAG_PREFIX);
}

export async function getTag(kv: KVNamespace, name: string): Promise<Tag | null> {
	const val = await kv.get(tagKey(name));
	return parseTag(val);
}

/** Tolerate a malformed tag record the same way the alias and log readers do. */
export function parseTag(value: string | null): Tag | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as Tag | null;
		return parsed && typeof parsed.name === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

export async function putTag(kv: KVNamespace, tag: Tag): Promise<void> {
	await kv.put(tagKey(tag.name), JSON.stringify(tag));
}

export async function deleteTag(kv: KVNamespace, name: string): Promise<void> {
	await kv.delete(tagKey(name));
}
