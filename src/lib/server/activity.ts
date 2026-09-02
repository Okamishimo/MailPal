import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { LogEntry } from '../types.js';
import { ACTIVITY_INSERT_SQL, activityInsertBindings, rowToLogEntry, type ActivityRow } from '../activity.js';
import { chunk, getMany, listKeys } from '../kv-batch.js';
import { LOG_PREFIX, deleteLog, logKey, parseLog } from '../kv.js';

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

// ─── Backup ───────────────────────────────────────────────────────────────────

// D1 caps the statements one batch may carry, and a restore can hold an entry
// for every alias, so inserts go out in fixed-size groups.
const INSERT_BATCH_SIZE = 50;

/**
 * The newest entries per alias, keyed by `<domain>/<localPart>`.
 *
 * A backup keeps the same bounded slice per alias the KV ring buffer held. The
 * backup's own limit counts entries, one per alias, so it would not stop an
 * unbounded history from blowing past the 10 MB file cap on its own.
 */
export async function listActivityForBackup(
	db: D1Database,
	perAlias = ALIAS_ACTIVITY_LIMIT
): Promise<Map<string, LogEntry[]>> {
	const rows = await queryRows(
		db,
		`SELECT ${ROW_COLUMNS} FROM (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY domain, local_part ORDER BY at DESC, id DESC
			) AS row_rank FROM activity
		) WHERE row_rank <= ?
		ORDER BY domain, local_part, at DESC`,
		[perAlias]
	);

	const grouped = new Map<string, LogEntry[]>();
	for (const row of rows) {
		const alias = `${row.domain}/${row.local_part}`;
		const entries = grouped.get(alias);
		if (entries) entries.push(rowToLogEntry(row));
		else grouped.set(alias, [rowToLogEntry(row)]);
	}
	return grouped;
}

/**
 * Overwrite one alias's activity with the entries from a backup.
 *
 * This mirrors what restoring a `log:` key used to do — a KV put replaced the
 * whole ring buffer — so importing the same backup twice cannot duplicate
 * anything. When D1 holds the data the legacy key is dropped as well, which is
 * what makes a restore consolidate a pre-D1 account into one store.
 */
export async function replaceAliasActivity(
	kv: KVNamespace,
	db: D1Database | undefined,
	domain: string,
	localPart: string,
	entries: LogEntry[]
): Promise<void> {
	if (!db) {
		await kv.put(logKey(domain, localPart), JSON.stringify(entries));
		return;
	}

	await runWrite(db, 'DELETE FROM activity WHERE domain = ? AND local_part = ?', [
		domain,
		localPart
	]);

	// Oldest first, so the autoincrementing id agrees with `at` and ties break
	// the same way they would have if the entries had arrived as mail.
	const ordered = [...entries].sort((a, b) => a.at - b.at);
	for (const group of chunk(ordered, INSERT_BATCH_SIZE)) {
		try {
			await db.batch(
				group.map((entry) =>
					db.prepare(ACTIVITY_INSERT_SQL).bind(...activityInsertBindings(domain, localPart, entry))
				)
			);
		} catch (error) {
			console.error(JSON.stringify({
				message: 'Activity restore failed for one batch',
				alias: `${localPart}@${domain}`,
				error: error instanceof Error ? error.message : String(error)
			}));
		}
	}

	await deleteLog(kv, domain, localPart);
}

/** Drop every activity row — the replace-mode restore's clean slate. */
export async function clearAllActivity(db: D1Database | undefined): Promise<void> {
	if (!db) return;
	await runWrite(db, 'DELETE FROM activity', []);
}

// ─── Migrating off the KV ring buffer ─────────────────────────────────────────

/**
 * Legacy keys moved per request.
 *
 * Each one costs a bulk read, a delete and an insert batch against D1, and a KV
 * delete. The free plan allows 1,000 subrequests to Cloudflare services per
 * invocation, so this stays well inside half the budget.
 */
export const MAX_ACTIVITY_MIGRATION_KEYS = 100;

export interface ActivityMigrationResult {
	/** Entries written to D1 by this call. */
	migrated: number;
	/** Aliases whose legacy key was cleared by this call. */
	aliases: number;
	complete: boolean;
}

/**
 * Move one bounded page of legacy `log:` keys into D1.
 *
 * Reads already merge both stores, so this is never required — it just retires
 * the leftover keys, which otherwise stay in every backup and cost a KV list on
 * each activity page load. The caller repeats until `complete` comes back true;
 * every page deletes the keys it moved, so a retry resumes on its own.
 */
export async function migrateLegacyActivity(
	kv: KVNamespace,
	db: D1Database
): Promise<ActivityMigrationResult> {
	const page = await kv.list({
		prefix: LOG_PREFIX,
		// The extra key tells us whether another bounded request is needed.
		limit: MAX_ACTIVITY_MIGRATION_KEYS + 1
	});
	const keys = page.keys.slice(0, MAX_ACTIVITY_MIGRATION_KEYS).map((key) => key.name);
	const complete = page.list_complete && page.keys.length <= MAX_ACTIVITY_MIGRATION_KEYS;
	if (keys.length === 0) return { migrated: 0, aliases: 0, complete: true };

	const values = await getMany(kv, keys);
	let migrated = 0;
	let aliases = 0;
	for (const key of keys) {
		const alias = splitLogKey(key);
		if (!alias) {
			// A key that does not name an alias has nowhere to go in D1, and
			// leaving it would stall every later page behind it.
			await kv.delete(key);
			continue;
		}
		const entries = parseLog(values.get(key));
		// replaceAliasActivity drops the KV key once the rows are in.
		await replaceAliasActivity(kv, db, alias.domain, alias.localPart, entries);
		migrated += entries.length;
		aliases += 1;
	}
	return { migrated, aliases, complete };
}
