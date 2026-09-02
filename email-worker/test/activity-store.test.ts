import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../src/lib/types.js';
import { ACTIVITY_INSERT_SQL, activityInsertBindings } from '../../src/lib/activity.js';
import {
	deleteAliasActivity,
	deleteDomainActivity,
	listAliasActivity,
	listRecentActivity
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

describe('reading activity', () => {
	it('merges D1 rows with leftover KV logs, newest first', async () => {
		const kv = new MemoryKV();
		await insert('orders', entry(300), entry(100));
		kv.store.set(`log:${DOMAIN}/legacy`, JSON.stringify([entry(200), entry(50)]));

		const entries = await listRecentActivity(asKV(kv), asD1Database(db));

		expect(entries.map((item) => item.at)).toEqual([300, 200, 100, 50]);
		expect(entries.map((item) => item.localPart)).toEqual(['orders', 'legacy', 'orders', 'legacy']);
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

	it('clears activity a replace-mode restore does not bring back', async () => {
		await insert('stale', entry(100));

		const source = new MemoryKV();
		seed(source);
		const backup = await createBackup(asKV(source));

		await restoreBackup(asKV(new MemoryKV()), backup, 'replace', asD1Database(db));

		expect(db.rows()).toEqual([]);
	});
});
