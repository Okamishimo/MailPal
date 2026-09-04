import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { LogEntry } from '../../src/lib/types.js';
import { ACTIVITY_INSERT_SQL, activityInsertBindings } from '../../src/lib/activity.js';
import {
	MAX_ACTIVITY_MIGRATION_KEYS,
	deleteAliasActivity,
	deleteDomainActivity,
	listAliasActivity,
	listRecentActivity,
	migrateLegacyActivity
} from '../../src/lib/server/activity.js';
import { createBackup, restoreBackup, validateBackup } from '../../src/lib/server/backup.js';
import { MemoryKV, asKV, makeAlias, makeDomain } from './helpers.js';
import { SqliteD1, asD1Database } from './d1.js';

const DOMAIN = 'aliases.example.com';

let db: SqliteD1;

beforeEach(() => {
	db = new SqliteD1();
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	db.close();
	vi.restoreAllMocks();
});

function entry(at: number, overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		at,
		action: 'forwarded',
		from: 'sender@example.com',
		to: 'inbox@example.net',
		...overrides
	};
}

async function insert(localPart: string, ...entries: LogEntry[]): Promise<void> {
	for (const item of entries) {
		await db
			.prepare(ACTIVITY_INSERT_SQL)
			.bind(...activityInsertBindings(DOMAIN, localPart, item))
			.run();
	}
}

/**
 * The same database with every insert batch rejected, standing in for D1
 * refusing writes — the daily row-write limit is the way this happens in
 * production, and it is what makes a delete of the entries' other copy unsafe.
 */
function withFailingInserts(source: SqliteD1): D1Database {
	return {
		prepare: (sql: string) => source.prepare(sql),
		batch: () => Promise.reject(new Error('D1_ERROR: too many rows written'))
	} as unknown as D1Database;
}

describe('reading activity', () => {
	it('merges D1 rows with leftover KV logs, newest first', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(300), entry(100));
		kv.store.set(`log:${DOMAIN}/legacy`, JSON.stringify([entry(200), entry(50)]));

		const entries = await listRecentActivity(asKV(kv), asD1Database(db));

		expect(entries.map((item) => item.at)).toEqual([300, 200, 100, 50]);
		expect(entries.map((item) => item.localPart)).toEqual(['orders', 'legacy', 'orders', 'legacy']);
	});

	it('reads a legacy key whose local part contains a slash', async () => {
		const kv = new MemoryKV();
		kv.store.set(`log:${DOMAIN}/bob/news`, JSON.stringify([entry(100)]));

		const entries = await listRecentActivity(asKV(kv), asD1Database(db));

		expect(entries.map((item) => item.localPart)).toEqual(['bob/news']);
	});

	it('honours the requested limit across both stores', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(400), entry(300));
		kv.store.set(`log:${DOMAIN}/legacy`, JSON.stringify([entry(200), entry(100)]));

		const entries = await listRecentActivity(asKV(kv), asD1Database(db), 3);
		expect(entries.map((item) => item.at)).toEqual([400, 300, 200]);
	});

	it('returns one alias without the alias fields the page adds', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(200, { subject: 'Receipt' }));
		await insert('other', entry(300));

		const log = await listAliasActivity(asKV(kv), asD1Database(db), DOMAIN, 'orders');

		expect(log).toEqual([
			{
				at: 200,
				action: 'forwarded',
				from: 'sender@example.com',
				to: 'inbox@example.net',
				recipient: 'orders@aliases.example.com',
				subject: 'Receipt'
			}
		]);
	});

	it('falls back to the KV log when the table is missing', async () => {
		const bare = new SqliteD1({ migrate: false });
		const kv = new MemoryKV();
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(100)]));

		const entries = await listRecentActivity(asKV(kv), asD1Database(bare));

		expect(entries.map((item) => item.at)).toEqual([100]);
		bare.close();
	});
});

describe('deleting activity', () => {
	it('clears one alias from both stores', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(100));
		await insert('other', entry(200));
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(50)]));

		await deleteAliasActivity(asKV(kv), asD1Database(db), DOMAIN, 'orders');

		expect(kv.store.has(`log:${DOMAIN}/orders`)).toBe(false);
		expect(db.rows().map((row) => row.local_part)).toEqual(['other']);
	});

	it('clears a whole domain in one statement', async () => {
		await insert('orders', entry(100));
		await insert('other', entry(200));
		await db
			.prepare(ACTIVITY_INSERT_SQL)
			.bind(...activityInsertBindings('other.example.com', 'keep', entry(300)))
			.run();

		await deleteDomainActivity(asD1Database(db), DOMAIN);

		expect(db.rows().map((row) => row.domain)).toEqual(['other.example.com']);
	});
});

describe('backups with a database bound', () => {
	function seed(kv: MemoryKV): void {
		const domain = makeDomain();
		const alias = makeAlias();
		kv.store.set(`domain:${domain.domain}`, JSON.stringify(domain));
		kv.store.set(`alias:${alias.domain}/${alias.localPart}`, JSON.stringify(alias));
		kv.store.set('settings:onboarded', '1');
	}

	it('exports D1 activity as the same log: entries a KV backup uses', async () => {
		const kv = new MemoryKV();
		seed(kv);
		await insert('orders', entry(100, { subject: 'First' }), entry(200, { subject: 'Second' }));

		const backup = await createBackup(asKV(kv), asD1Database(db));
		const log = backup.entries.find((item) => item.key === `log:${DOMAIN}/orders`);

		expect(log).toBeDefined();
		expect((JSON.parse(log!.value) as LogEntry[]).map((item) => item.subject)).toEqual([
			'Second',
			'First'
		]);
		expect((await validateBackup(backup)).ok).toBe(true);
	});

	it('merges an alias that has history in both stores', async () => {
		const kv = new MemoryKV();
		seed(kv);
		await insert('orders', entry(300));
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(100)]));

		const backup = await createBackup(asKV(kv), asD1Database(db));
		const log = backup.entries.find((item) => item.key === `log:${DOMAIN}/orders`)!;

		expect((JSON.parse(log.value) as LogEntry[]).map((item) => item.at)).toEqual([300, 100]);
	});

	it('restores a pre-D1 backup into the database and drops the legacy key', async () => {
		const source = new MemoryKV();
		seed(source);
		source.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200), entry(100)]));
		const backup = await createBackup(asKV(source));

		const target = new MemoryKV();
		await restoreBackup(asKV(target), backup, 'replace', asD1Database(db));

		expect(target.store.has(`log:${DOMAIN}/orders`)).toBe(false);
		expect(db.rows().map((row) => row.at)).toEqual([100, 200]);

		const log = await listAliasActivity(asKV(target), asD1Database(db), DOMAIN, 'orders');
		expect(log.map((item) => item.at)).toEqual([200, 100]);
	});

	it('does not duplicate rows when the same backup is imported twice', async () => {
		const source = new MemoryKV();
		seed(source);
		source.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200), entry(100)]));
		const backup = await createBackup(asKV(source));

		const target = new MemoryKV();
		await restoreBackup(asKV(target), backup, 'merge', asD1Database(db));
		await restoreBackup(asKV(target), backup, 'merge', asD1Database(db));

		expect(db.rows()).toHaveLength(2);
	});

	it("keeps the target's own legacy key when the restore cannot write to D1", async () => {
		const source = new MemoryKV();
		seed(source);
		source.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200)]));
		const backup = await createBackup(asKV(source));

		// The target is a pre-D1 install: consolidating its key into D1 is only
		// safe once the rows are actually there.
		const target = new MemoryKV();
		target.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(50)]));
		await restoreBackup(asKV(target), backup, 'merge', withFailingInserts(db));

		expect(target.store.get(`log:${DOMAIN}/orders`)).toBe(JSON.stringify([entry(50)]));
		expect(db.rows()).toEqual([]);
	});

	it('clears activity a replace-mode restore does not bring back', async () => {
		await insert('stale', entry(100));

		const source = new MemoryKV();
		seed(source);
		const backup = await createBackup(asKV(source));

		await restoreBackup(asKV(new MemoryKV()), backup, 'replace', asD1Database(db));

		expect(db.rows()).toEqual([]);
	});
});

describe('migrating off the KV ring buffer', () => {
	it('moves every legacy key into D1 and deletes it', async () => {
		const kv = new MemoryKV();
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200), entry(100)]));
		kv.store.set(`log:${DOMAIN}/news`, JSON.stringify([entry(300)]));

		const result = await migrateLegacyActivity(asKV(kv), asD1Database(db));

		expect(result).toEqual({ migrated: 3, aliases: 2, failed: 0, complete: true });
		expect([...kv.store.keys()].filter((key) => key.startsWith('log:'))).toEqual([]);
		expect(db.rows()).toHaveLength(3);

		const entries = await listRecentActivity(asKV(kv), asD1Database(db));
		expect(entries.map((item) => item.at)).toEqual([300, 200, 100]);
	});

	it('reports nothing to do when no legacy keys remain', async () => {
		const result = await migrateLegacyActivity(asKV(new MemoryKV()), asD1Database(db));
		expect(result).toEqual({ migrated: 0, aliases: 0, failed: 0, complete: true });
	});

	it('pages through more keys than one call moves', async () => {
		const kv = new MemoryKV();
		for (let index = 0; index <= MAX_ACTIVITY_MIGRATION_KEYS; index += 1) {
			kv.store.set(`log:${DOMAIN}/alias${index}`, JSON.stringify([entry(index + 1)]));
		}

		const first = await migrateLegacyActivity(asKV(kv), asD1Database(db));
		expect(first.complete).toBe(false);
		expect(first.aliases).toBe(MAX_ACTIVITY_MIGRATION_KEYS);

		const second = await migrateLegacyActivity(asKV(kv), asD1Database(db));
		expect(second).toEqual({ migrated: 1, aliases: 1, failed: 0, complete: true });
		expect(db.rows()).toHaveLength(MAX_ACTIVITY_MIGRATION_KEYS + 1);
	});

	it('drops a key that does not name an alias instead of stalling on it', async () => {
		const kv = new MemoryKV();
		kv.store.set('log:no-slash', JSON.stringify([entry(100)]));

		const result = await migrateLegacyActivity(asKV(kv), asD1Database(db));

		expect(result).toEqual({ migrated: 0, aliases: 0, failed: 0, complete: true });
		expect(kv.store.has('log:no-slash')).toBe(false);
	});

	it('appends to the rows D1 recorded after the binding was added', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(1000), entry(1001));
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200), entry(100)]));

		const result = await migrateLegacyActivity(asKV(kv), asD1Database(db));

		expect(result).toEqual({ migrated: 2, aliases: 1, failed: 0, complete: true });
		const log = await listAliasActivity(asKV(kv), asD1Database(db), DOMAIN, 'orders');
		expect(log.map((item) => item.at)).toEqual([1001, 1000, 200, 100]);
	});

	it('keeps the legacy key when the insert fails, so nothing is lost', async () => {
		const kv = new MemoryKV();
		kv.store.set(`log:${DOMAIN}/orders`, JSON.stringify([entry(200), entry(100)]));

		const result = await migrateLegacyActivity(asKV(kv), withFailingInserts(db));

		expect(result).toEqual({ migrated: 0, aliases: 0, failed: 1, complete: false });
		expect(kv.store.has(`log:${DOMAIN}/orders`)).toBe(true);
		expect(db.rows()).toEqual([]);
	});

	it('moves an alias whose local part contains a slash', async () => {
		const kv = new MemoryKV();
		kv.store.set(`log:${DOMAIN}/bob/news`, JSON.stringify([entry(100)]));

		const result = await migrateLegacyActivity(asKV(kv), asD1Database(db));

		expect(result).toEqual({ migrated: 1, aliases: 1, failed: 0, complete: true });
		expect(kv.store.has(`log:${DOMAIN}/bob/news`)).toBe(false);
		expect(db.rows().map((row) => row.local_part)).toEqual(['bob/news']);
	});
});
