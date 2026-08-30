import type { KVNamespace } from '@cloudflare/workers-types';
import type {
	AliasConfig,
	DestinationAddress,
	DomainConfig,
	GlobalSenderBlocklist,
	LogEntry,
	Tag
} from './types.js';
import { normalizeGlobalSenderBlocklist, sanitizeSubject } from './sender-rules.js';

const GLOBAL_SENDER_BLOCKLIST_KEY = 'settings:sender-blocklist';

// ─── Domain helpers ───────────────────────────────────────────────────────────

export async function getDomain(
	kv: KVNamespace,
	domain: string
): Promise<DomainConfig | null> {
	const val = await kv.get(`domain:${domain}`);
	return val ? (JSON.parse(val) as DomainConfig) : null;
}

export async function putDomain(kv: KVNamespace, config: DomainConfig): Promise<void> {
	await kv.put(`domain:${config.domain}`, JSON.stringify(config));
}

export async function deleteDomain(kv: KVNamespace, domain: string): Promise<void> {
	await kv.delete(`domain:${domain}`);
}

export async function listDomains(kv: KVNamespace): Promise<DomainConfig[]> {
	const list = await kv.list({ prefix: 'domain:' });
	const configs = await Promise.all(
		list.keys.map(async (k) => {
			const val = await kv.get(k.name);
			return val ? (JSON.parse(val) as DomainConfig) : null;
		})
	);
	return configs.filter((c): c is DomainConfig => c !== null);
}

// ─── Alias helpers ────────────────────────────────────────────────────────────

export function aliasKey(domain: string, localPart: string): string {
	return `alias:${domain}/${localPart}`;
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
	const list = await kv.list({ prefix: `alias:${domain}/` });
	const configs = await Promise.all(
		list.keys.map(async (k) => {
			const val = await kv.get(k.name);
			return val ? (JSON.parse(val) as AliasConfig) : null;
		})
	);
	return configs.filter((c): c is AliasConfig => c !== null);
}

// ─── Destination address helpers ──────────────────────────────────────────────

export async function listDestinations(kv: KVNamespace): Promise<DestinationAddress[]> {
	const list = await kv.list({ prefix: 'destination:' });
	const configs = await Promise.all(
		list.keys.map(async (k) => {
			const val = await kv.get(k.name);
			return val ? (JSON.parse(val) as DestinationAddress) : null;
		})
	);
	return configs.filter((c): c is DestinationAddress => c !== null);
}

export async function putDestination(kv: KVNamespace, dest: DestinationAddress): Promise<void> {
	await kv.put(`destination:${dest.email}`, JSON.stringify(dest));
}

export async function deleteDestination(kv: KVNamespace, email: string): Promise<void> {
	await kv.delete(`destination:${email}`);
}

// ─── Activity log helpers ─────────────────────────────────────────────────────

export async function getLog(
	kv: KVNamespace,
	domain: string,
	localPart: string
): Promise<LogEntry[]> {
	const val = await kv.get(`log:${domain}/${localPart}`);
	const log = val ? (JSON.parse(val) as LogEntry[]) : [];
	// Entries written before subjects were decoded still hold RFC 2047
	// encoded-words; decoding on read keeps that history readable.
	return log.map((entry) =>
		typeof entry.subject === 'string' ? { ...entry, subject: sanitizeSubject(entry.subject) } : entry
	);
}

export async function deleteLog(kv: KVNamespace, domain: string, localPart: string): Promise<void> {
	await kv.delete(`log:${domain}/${localPart}`);
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

export async function listTags(kv: KVNamespace): Promise<Tag[]> {
	const list = await kv.list({ prefix: 'tag:' });
	const configs = await Promise.all(
		list.keys.map(async (k) => {
			const val = await kv.get(k.name);
			return val ? (JSON.parse(val) as Tag) : null;
		})
	);
	return configs.filter((c): c is Tag => c !== null);
}

export async function putTag(kv: KVNamespace, tag: Tag): Promise<void> {
	await kv.put(`tag:${tag.name}`, JSON.stringify(tag));
}

export async function deleteTag(kv: KVNamespace, name: string): Promise<void> {
	await kv.delete(`tag:${name}`);
}
