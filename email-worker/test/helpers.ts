import { vi } from 'vitest';
import type {
	D1Database,
	ExecutionContext,
	ForwardableEmailMessage,
	KVNamespace
} from '@cloudflare/workers-types';
import type {
	AliasConfig,
	DomainConfig,
	GlobalSenderBlocklist,
	LogEntry
} from '../../src/lib/types.js';
import { handleEmail } from '../src/index.js';

/**
 * In-memory stand-in for a Cloudflare KV namespace. Implements the subset of the
 * KV API that both the worker (`get`/`put`) and the dashboard helpers in
 * `src/lib/kv.ts` (`delete`/`list`) rely on, so the same fake can drive both the
 * mail-delivery tests and the dashboard↔worker contract tests.
 */
export class MemoryKV {
	store = new Map<string, string>();
	getCalls: Array<string | string[]> = [];
	listCalls: Array<{ prefix?: string; cursor?: string; limit?: number }> = [];
	mutationCalls: Array<{ operation: 'put' | 'delete'; key: string }> = [];

	async get(key: string): Promise<string | null>;
	async get(keys: string[]): Promise<Map<string, string | null>>;
	async get(keyOrKeys: string | string[]): Promise<string | null | Map<string, string | null>> {
		this.getCalls.push(keyOrKeys);
		if (Array.isArray(keyOrKeys)) {
			const responseKeys = [...keyOrKeys].sort();
			return new Map(responseKeys.map((key) => [key, this.store.get(key) ?? null]));
		}
		return this.store.get(keyOrKeys) ?? null;
	}

	resetGetCalls(): void {
		this.getCalls = [];
	}

	async put(key: string, value: string): Promise<void> {
		this.mutationCalls.push({ operation: 'put', key });
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.mutationCalls.push({ operation: 'delete', key });
		this.store.delete(key);
	}

	async list({ prefix, cursor, limit }: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<
		| { keys: { name: string }[]; list_complete: false; cursor: string }
		| { keys: { name: string }[]; list_complete: true }
	> {
		this.listCalls.push({ prefix, cursor, limit });
		const all = [...this.store.keys()]
			.filter((name) => !prefix || name.startsWith(prefix))
			.sort();
		const start = cursor ? Number(cursor) : 0;
		const page = all.slice(start, start + (limit ?? 1000));
		const end = start + page.length;
		const keys = page.map((name) => ({ name }));
		return end < all.length
			? { keys, list_complete: false, cursor: String(end) }
			: { keys, list_complete: true };
	}
}

export function asKV(kv: MemoryKV): KVNamespace {
	return kv as unknown as KVNamespace;
}

/**
 * In-memory stand-in for a D1 database. The delivery path only ever calls
 * `prepare().bind().run()`, so that is the whole implemented surface; every
 * statement is recorded so a test can assert the row that would be written.
 */
export class MemoryD1 {
	statements: Array<{ sql: string; bindings: unknown[] }> = [];
	/** When set, `run()` rejects — used to prove a failed insert still delivers. */
	failure: Error | null = null;

	prepare(sql: string) {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const db = this;
		return {
			bind(...bindings: unknown[]) {
				return {
					async run() {
						if (db.failure) throw db.failure;
						db.statements.push({ sql, bindings });
						return { success: true };
					}
				};
			}
		};
	}
}

export function asD1(db: MemoryD1): D1Database {
	return db as unknown as D1Database;
}

export const EMPTY_GLOBAL_BLOCKLIST: GlobalSenderBlocklist = {
	blockedSenderAddresses: [],
	blockedSenderDomains: []
};

export function makeDomain(overrides: Partial<DomainConfig> = {}): DomainConfig {
	return {
		domain: 'aliases.example.com',
		targetEmail: 'inbox@example.net',
		wildcardEnabled: false,
		enabled: true,
		createdAt: 1,
		...overrides
	};
}

export function makeAlias(overrides: Partial<AliasConfig> = {}): AliasConfig {
	return {
		localPart: 'orders',
		domain: 'aliases.example.com',
		targetEmail: null,
		enabled: true,
		createdAt: 1,
		forwardedCount: 0,
		blockedCount: 0,
		lastUsedAt: null,
		autoCreated: false,
		...overrides
	};
}

export interface RunOptions {
	/** `undefined` uses a default alias; `null` stores no alias key. */
	alias?: AliasConfig | null;
	/** `undefined` uses a default domain; `null` stores no domain key. */
	domain?: DomainConfig | null;
	/** Store an arbitrary (possibly malformed) raw value at the domain key. */
	rawDomain?: string;
	/** Store an arbitrary (possibly malformed) raw value at the alias key. */
	rawAlias?: string;
	rawGlobalBlocklist?: string;
	from?: string | null;
	to?: string;
	subject?: string;
	headerFrom?: string;
	cc?: string;
	globalBlocklist?: GlobalSenderBlocklist;
	/** Override the `forward` implementation, e.g. to simulate a delivery failure. */
	forward?: (address: string) => Promise<unknown>;
	/** Reuse an existing store instead of a fresh one. */
	kv?: MemoryKV;
	/** Bind a D1 database; omit it to exercise the legacy KV log fallback. */
	db?: MemoryD1;
}

export interface RunResult {
	kv: MemoryKV;
	db?: MemoryD1;
	forward: ReturnType<typeof vi.fn>;
	setReject: ReturnType<typeof vi.fn>;
}

export async function runEmail(options: RunOptions = {}): Promise<RunResult> {
	const kv = options.kv ?? new MemoryKV();

	if (options.rawDomain !== undefined) {
		kv.store.set('domain:aliases.example.com', options.rawDomain);
	} else if (options.domain !== null) {
		const domain = options.domain ?? makeDomain();
		kv.store.set(`domain:${domain.domain}`, JSON.stringify(domain));
	}

	if (options.rawAlias !== undefined) {
		kv.store.set('alias:aliases.example.com/orders', options.rawAlias);
	} else {
		const alias = options.alias === undefined ? makeAlias() : options.alias;
		if (alias) kv.store.set(`alias:${alias.domain}/${alias.localPart}`, JSON.stringify(alias));
	}

	if (options.rawGlobalBlocklist !== undefined) {
		kv.store.set('settings:sender-blocklist', options.rawGlobalBlocklist);
	} else if (options.globalBlocklist) {
		kv.store.set('settings:sender-blocklist', JSON.stringify(options.globalBlocklist));
	}

	const headers = new Headers();
	if (options.subject !== undefined) headers.set('subject', options.subject);
	if (options.headerFrom !== undefined) headers.set('from', options.headerFrom);
	if (options.cc !== undefined) headers.set('cc', options.cc);

	const forward = vi.fn(options.forward ?? (async () => ({ messageId: 'test-message' })));
	const setReject = vi.fn();
	const message = {
		from: options.from === undefined ? 'sender@example.com' : options.from,
		to: options.to ?? 'orders@aliases.example.com',
		headers,
		raw: new ReadableStream<Uint8Array>(),
		rawSize: 0,
		forward,
		setReject,
		reply: vi.fn()
	} as unknown as ForwardableEmailMessage;

	const background: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			background.push(promise);
		},
		passThroughOnException() {},
		props: {}
	} as unknown as ExecutionContext;

	const env = {
		KV: asKV(kv),
		...(options.db ? { DB: asD1(options.db) } : {})
	} as Env;
	await handleEmail(message, env, ctx);
	await Promise.all(background);

	return { kv, db: options.db, forward, setReject };
}

export function readAlias(kv: MemoryKV, localPart = 'orders'): AliasConfig {
	return JSON.parse(kv.store.get(`alias:aliases.example.com/${localPart}`)!) as AliasConfig;
}

export function readLog(kv: MemoryKV, localPart = 'orders'): LogEntry[] {
	return JSON.parse(kv.store.get(`log:aliases.example.com/${localPart}`) ?? '[]') as LogEntry[];
}
