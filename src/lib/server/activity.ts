import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { LogEntry } from '../types.js';
import { rowToLogEntry, type ActivityRow } from '../activity.js';
import { getMany, listKeys } from '../kv-batch.js';
import { LOG_PREFIX, deleteLog, parseLog } from '../kv.js';

/**
 * Reads over the activity log.
 *
 * Entries live in D1 (see migrations/0001_create_activity.sql), but two other
 * cases have to keep working: a deployment with no `DB` binding, which still
 * writes the legacy `log:` KV ring buffer, and a deployment that has just bound
 * one and whose history is still sitting in KV. So every read merges D1 with
 * whatever `log:` keys remain. Once those keys are gone — the import route
 * clears them — the merge costs a single empty KV list.
 */

export interface ActivityEntry extends LogEntry {
	localPart: string;
	domain: string;
}

/** Entries shown on the activity page. */
export const ACTIVITY_PAGE_LIMIT = 200;
/** Entries kept per alias by the KV ring buffer, and shown in the alias drawer. */
export const ALIAS_ACTIVITY_LIMIT = 50;

const ROW_COLUMNS =
	'domain, local_part, at, action, from_addr, to_addr, reason, matched_rule, subject, header_from, cc';

function splitLogKey(key: string): { domain: string; localPart: string } | null {
	const suffix = key.slice(LOG_PREFIX.length);
	const slash = suffix.indexOf('/');
	if (slash <= 0 || slash !== suffix.lastIndexOf('/') || slash === suffix.length - 1) return null;
	return { domain: suffix.slice(0, slash), localPart: suffix.slice(slash + 1) };
}

/**
 * Run a read against D1, degrading to an empty result instead of throwing.
 *
 * A binding that points at a database whose migrations have not been applied
 * yet would otherwise turn every dashboard page into a 500 — the one state a
 * half-finished setup is most likely to be in.
 */
async function queryRows(
	db: D1Database,
	sql: string,
	bindings: unknown[]
): Promise<ActivityRow[]> {
	try {
		const result = await db
			.prepare(sql)
			.bind(...bindings)
			.all<ActivityRow>();
		return result.results ?? [];
	} catch (error) {
		console.error(JSON.stringify({
			message: 'Activity query failed — falling back to the legacy KV log',
			error: error instanceof Error ? error.message : String(error)
		}));
		return [];
	}
}

async function listLegacyActivity(kv: KVNamespace): Promise<ActivityEntry[]> {
	const keys = await listKeys(kv, LOG_PREFIX);
	if (keys.length === 0) return [];

	const values = await getMany(kv, keys);
	return keys.flatMap((key) => {
		const alias = splitLogKey(key);
		if (!alias) return [];
		return parseLog(values.get(key)).map((entry): ActivityEntry => ({ ...entry, ...alias }));
	});
}

function newestFirst(entries: ActivityEntry[], limit: number): ActivityEntry[] {
	return [...entries].sort((a, b) => b.at - a.at).slice(0, limit);
}

function toActivityEntry(row: ActivityRow): ActivityEntry {
	return { ...rowToLogEntry(row), domain: row.domain, localPart: row.local_part };
}

/** The newest entries across every alias. */
export async function listRecentActivity(
	kv: KVNamespace,
	db: D1Database | undefined,
	limit = ACTIVITY_PAGE_LIMIT
): Promise<ActivityEntry[]> {
	const [rows, legacy] = await Promise.all([
		db
			? queryRows(
					db,
					`SELECT ${ROW_COLUMNS} FROM activity ORDER BY at DESC, id DESC LIMIT ?`,
					[limit]
				)
			: Promise.resolve<ActivityRow[]>([]),
		listLegacyActivity(kv)
	]);
	return newestFirst([...rows.map(toActivityEntry), ...legacy], limit);
}

/** The newest entries for one alias, newest first. */
export async function listAliasActivity(
	kv: KVNamespace,
	db: D1Database | undefined,
	domain: string,
	localPart: string,
	limit = ALIAS_ACTIVITY_LIMIT
): Promise<LogEntry[]> {
	const [rows, legacy] = await Promise.all([
		db
			? queryRows(
					db,
					`SELECT ${ROW_COLUMNS} FROM activity
					 WHERE domain = ? AND local_part = ?
					 ORDER BY at DESC, id DESC LIMIT ?`,
					[domain, localPart, limit]
				)
			: Promise.resolve<ActivityRow[]>([]),
		listLegacyActivity(kv).then((entries) =>
			entries.filter((entry) => entry.domain === domain && entry.localPart === localPart)
		)
	]);
	return newestFirst([...rows.map(toActivityEntry), ...legacy], limit).map(
		({ domain: _domain, localPart: _localPart, ...entry }) => entry
	);
}

/**
 * Run a write against D1, reporting failures instead of throwing.
 *
 * Callers are deleting activity alongside the alias or domain that owns it. The
 * owning record is the one the UI reads, so losing it to a failed activity
 * delete would strand the entity; leaving activity rows behind is recoverable.
 */
async function runWrite(db: D1Database, sql: string, bindings: unknown[]): Promise<void> {
	try {
		await db
			.prepare(sql)
			.bind(...bindings)
			.run();
	} catch (error) {
		console.error(JSON.stringify({
			message: 'Activity delete failed — rows may be orphaned',
			error: error instanceof Error ? error.message : String(error)
		}));
	}
}

/** Drop one alias's activity from both stores. */
export async function deleteAliasActivity(
	kv: KVNamespace,
	db: D1Database | undefined,
	domain: string,
	localPart: string
): Promise<void> {
	await Promise.all([
		deleteLog(kv, domain, localPart),
		db
			? runWrite(db, 'DELETE FROM activity WHERE domain = ? AND local_part = ?', [
					domain,
					localPart
				])
			: Promise.resolve()
	]);
}

/**
 * Drop every activity row for a domain in one statement.
 *
 * The KV side has no equivalent — its keys are per alias, so the domain cascade
 * still deletes those one by one as it pages through the aliases.
 */
export async function deleteDomainActivity(
	db: D1Database | undefined,
	domain: string
): Promise<void> {
	if (!db) return;
	await runWrite(db, 'DELETE FROM activity WHERE domain = ?', [domain]);
}
