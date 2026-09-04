import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_INSERT_SQL, rowToLogEntry, type ActivityRow } from '../../src/lib/activity.js';
import { MemoryD1, makeAlias, readAlias, readLog, runEmail } from './helpers.js';

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** Rebuild the row a recorded INSERT would have produced, in column order. */
function insertedRow(db: MemoryD1, index = 0): ActivityRow {
	const columns = [
		'domain',
		'local_part',
		'at',
		'action',
		'from_addr',
		'to_addr',
		'reason',
		'matched_rule',
		'subject',
		'header_from',
		'cc'
	] as const;
	const { bindings } = db.statements[index];
	return Object.fromEntries(
		columns.map((column, position) => [column, bindings[position]])
	) as unknown as ActivityRow;
}

describe('activity written to D1', () => {
	it('records a forwarded message as one insert and no KV log write', async () => {
		const db = new MemoryD1();
		const { kv, forward } = await runEmail({
			db,
			subject: 'Order #42 confirmed',
			cc: 'ops@example.com'
		});

		expect(forward).toHaveBeenCalledWith('inbox@example.net');
		expect(db.statements).toHaveLength(1);
		expect(db.statements[0].sql).toBe(ACTIVITY_INSERT_SQL);
		expect(readLog(kv)).toEqual([]);
		expect(kv.store.has('log:aliases.example.com/orders')).toBe(false);

		expect(rowToLogEntry(insertedRow(db))).toMatchObject({
			action: 'forwarded',
			from: 'sender@example.com',
			to: 'inbox@example.net',
			recipient: 'orders@aliases.example.com',
			subject: 'Order #42 confirmed',
			cc: ['ops@example.com']
		});
	});

	it('halves the KV writes a delivery costs', async () => {
		const withD1 = await runEmail({ db: new MemoryD1() });
		const withoutD1 = await runEmail({});

		const puts = (result: Awaited<ReturnType<typeof runEmail>>) =>
			result.kv.mutationCalls.filter((call) => call.operation === 'put');

		expect(puts(withD1)).toHaveLength(1);
		expect(puts(withoutD1)).toHaveLength(2);
	});

	it('records a blocked message with its reason', async () => {
		const db = new MemoryD1();
		const { setReject } = await runEmail({
			db,
			alias: makeAlias({ enabled: false })
		});

		expect(setReject).toHaveBeenCalled();
		expect(db.statements).toHaveLength(1);
		expect(rowToLogEntry(insertedRow(db))).toMatchObject({
			action: 'blocked',
			reason: 'alias_disabled',
			recipient: 'orders@aliases.example.com'
		});
	});

	it('still counts the message on the alias when the insert fails', async () => {
		const db = new MemoryD1();
		db.failure = new Error('D1_ERROR: daily row write limit reached');
		const { kv, forward } = await runEmail({ db });

		// Recording is best-effort background work: a database that rejects the
		// insert must never cost the recipient their mail.
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
		expect(readAlias(kv).forwardedCount).toBe(1);
	});

	it('falls back to the KV ring buffer when no database is bound', async () => {
		const { kv } = await runEmail({});
		expect(readLog(kv)).toHaveLength(1);
		expect(readLog(kv)[0]).toMatchObject({ action: 'forwarded' });
	});
});
