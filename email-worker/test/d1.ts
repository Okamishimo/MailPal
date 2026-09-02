import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { D1Database } from '@cloudflare/workers-types';

const MIGRATION = new URL('../../migrations/0001_create_activity.sql', import.meta.url);

/**
 * A real SQLite database standing in for D1, loaded with the project's own
 * migration.
 *
 * The activity code is mostly SQL — a window function for the backup export,
 * indexed ordering, cascading deletes — so a hand-rolled fake would only ever
 * assert the strings we wrote. Running the statements against SQLite tests the
 * queries and the migration file together.
 */
class BoundStatement {
	constructor(
		private readonly db: DatabaseSync,
		readonly sql: string,
		readonly values: unknown[]
	) {}

	private statement(): StatementSync {
		return this.db.prepare(this.sql);
	}

	async all<T>(): Promise<{ results: T[]; success: true }> {
		return { results: this.statement().all(...(this.values as never[])) as T[], success: true };
	}

	async first<T>(): Promise<T | null> {
		return (this.statement().get(...(this.values as never[])) ?? null) as T | null;
	}

	async run(): Promise<{ success: true }> {
		this.statement().run(...(this.values as never[]));
		return { success: true };
	}
}

export class SqliteD1 {
	private readonly db: DatabaseSync;
	/** Every statement executed, so a test can count round trips. */
	readonly executed: string[] = [];

	constructor({ migrate = true }: { migrate?: boolean } = {}) {
		this.db = new DatabaseSync(':memory:');
		if (migrate) this.db.exec(readFileSync(MIGRATION, 'utf8'));
	}

	prepare(sql: string) {
		this.executed.push(sql);
		const db = this.db;
		return {
			bind: (...values: unknown[]) => new BoundStatement(db, sql, values),
			all: <T>() => new BoundStatement(db, sql, []).all<T>(),
			first: <T>() => new BoundStatement(db, sql, []).first<T>(),
			run: () => new BoundStatement(db, sql, []).run()
		};
	}

	async batch(statements: BoundStatement[]): Promise<{ success: true }[]> {
		this.db.exec('BEGIN');
		try {
			for (const statement of statements) await statement.run();
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
		return statements.map(() => ({ success: true as const }));
	}

	/** Rows as stored, for assertions that should not go through the read path. */
	rows(): Record<string, unknown>[] {
		return this.db
			.prepare('SELECT * FROM activity ORDER BY id')
			.all() as unknown as Record<string, unknown>[];
	}

	close(): void {
		this.db.close();
	}
}

export function asD1Database(db: SqliteD1): D1Database {
	return db as unknown as D1Database;
}
