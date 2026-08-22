import { vi } from 'vitest';
import type {
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

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list({ prefix }: { prefix?: string } = {}): Promise<{
		keys: { name: string }[];
		list_complete: boolean;
	}> {
		const keys = [...this.store.keys()]
			.filter((name) => !prefix || name.startsWith(prefix))
			.sort()
			.map((name) => ({ name }));
		return { keys, list_complete: true };
	}
}

export function asKV(kv: MemoryKV): KVNamespace {
	return kv as unknown as KVNamespace;
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
	globalBlocklist?: GlobalSenderBlocklist;
	/** Override the `forward` implementation, e.g. to simulate a delivery failure. */
	forward?: (address: string) => Promise<unknown>;
	/** Reuse an existing store instead of a fresh one. */
	kv?: MemoryKV;
}

export interface RunResult {
	kv: MemoryKV;
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

	await handleEmail(message, { KV: asKV(kv) } as Env, ctx);
	await Promise.all(background);

	return { kv, forward, setReject };
}

export function readAlias(kv: MemoryKV, localPart = 'orders'): AliasConfig {
	return JSON.parse(kv.store.get(`alias:aliases.example.com/${localPart}`)!) as AliasConfig;
}

export function readLog(kv: MemoryKV, localPart = 'orders'): LogEntry[] {
	return JSON.parse(kv.store.get(`log:aliases.example.com/${localPart}`) ?? '[]') as LogEntry[];
}
