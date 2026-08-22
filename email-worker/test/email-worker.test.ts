import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
	domainMatches,
	evaluateSenderRules,
	normalizeEmailAddress,
	normalizeSenderRules,
	sanitizeSubject,
	validateSenderRules
} from '../../src/lib/sender-rules.js';
import { appendLog, handleEmail } from '../src/index.js';

class MemoryKV {
	store = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}
}

const EMPTY_GLOBAL_BLOCKLIST: GlobalSenderBlocklist = {
	blockedSenderAddresses: [],
	blockedSenderDomains: []
};

function makeDomain(overrides: Partial<DomainConfig> = {}): DomainConfig {
	return {
		domain: 'aliases.example.com',
		targetEmail: 'inbox@example.net',
		wildcardEnabled: false,
		enabled: true,
		createdAt: 1,
		...overrides
	};
}

function makeAlias(overrides: Partial<AliasConfig> = {}): AliasConfig {
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

interface RunOptions {
	alias?: AliasConfig | null;
	domain?: DomainConfig;
	from?: string | null;
	to?: string;
	subject?: string;
	headerFrom?: string;
	globalBlocklist?: GlobalSenderBlocklist;
}

async function runEmail(options: RunOptions = {}) {
	const kv = new MemoryKV();
	const domain = options.domain ?? makeDomain();
	kv.store.set(`domain:${domain.domain}`, JSON.stringify(domain));
	const alias = options.alias === undefined ? makeAlias() : options.alias;
	if (alias) kv.store.set(`alias:${alias.domain}/${alias.localPart}`, JSON.stringify(alias));
	if (options.globalBlocklist) {
		kv.store.set('settings:sender-blocklist', JSON.stringify(options.globalBlocklist));
	}

	const headers = new Headers();
	if (options.subject !== undefined) headers.set('subject', options.subject);
	if (options.headerFrom !== undefined) headers.set('from', options.headerFrom);

	const forward = vi.fn(async () => ({ messageId: 'test-message' }));
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

	await handleEmail(message, { KV: kv as unknown as KVNamespace }, ctx);
	await Promise.all(background);

	return { kv, forward, setReject };
}

function readAlias(kv: MemoryKV, localPart = 'orders'): AliasConfig {
	return JSON.parse(kv.store.get(`alias:aliases.example.com/${localPart}`)!) as AliasConfig;
}

function readLog(kv: MemoryKV, localPart = 'orders'): LogEntry[] {
	return JSON.parse(kv.store.get(`log:aliases.example.com/${localPart}`) ?? '[]') as LogEntry[];
}

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sender normalization and deterministic matching', () => {
	it('normalizes complete addresses and matches exact addresses only', () => {
		expect(normalizeEmailAddress('  Orders@Amazon.COM ')).toBe('orders@amazon.com');
		expect(normalizeEmailAddress('Orders <orders@amazon.com>')).toBeNull();

		const allowed = evaluateSenderRules('ORDERS@AMAZON.COM', makeAlias({
			senderMode: 'allowlist',
			allowedSenderAddresses: ['orders@amazon.com']
		}), EMPTY_GLOBAL_BLOCKLIST);
		const denied = evaluateSenderRules('other@amazon.com', makeAlias({
			senderMode: 'allowlist',
			allowedSenderAddresses: ['orders@amazon.com']
		}), EMPTY_GLOBAL_BLOCKLIST);

		expect(allowed.allowed).toBe(true);
		expect(allowed.sender).toBe('orders@amazon.com');
		expect(denied.reason).toBe('sender_not_in_allowlist');
	});

	it('matches exact domains and subdomains only on label boundaries', () => {
		expect(domainMatches('amazon.com', 'amazon.com')).toBe(true);
		expect(domainMatches('mail.amazon.com', 'amazon.com')).toBe(true);
		expect(domainMatches('fakeamazon.com', 'amazon.com')).toBe(false);
		expect(domainMatches('amazon.com.evil.example', 'amazon.com')).toBe(false);
	});

	it('rejects malformed addresses, domains, URLs, and wildcard fragments', () => {
		for (const value of [null, '', 'sender', 'a@@example.com', 'a@fake..example', 'A <a@example.com>']) {
			expect(normalizeEmailAddress(value)).toBeNull();
		}

		const invalidRules = validateSenderRules({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: ['https://example.com'],
			blockedSenderAddresses: [],
			blockedSenderDomains: []
		});
		const wildcardRules = validateSenderRules({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: [],
			blockedSenderAddresses: [],
			blockedSenderDomains: ['*.example.com']
		});

		expect(invalidRules.ok).toBe(false);
		expect(wildcardRules.ok).toBe(false);
	});

	it('gives global and alias blocks precedence over allow rules', () => {
		const alias = makeAlias({
			senderMode: 'allowlist',
			allowedSenderDomains: ['amazon.com'],
			blockedSenderAddresses: ['orders@amazon.com']
		});

		expect(evaluateSenderRules('orders@amazon.com', alias, {
			blockedSenderAddresses: ['orders@amazon.com'],
			blockedSenderDomains: []
		}).reason).toBe('global_sender_blocked');

		expect(evaluateSenderRules('orders@amazon.com', alias, EMPTY_GLOBAL_BLOCKLIST).reason)
			.toBe('alias_sender_blocked');
	});

	it('defaults legacy aliases to normal mode with empty lists', () => {
		const rules = normalizeSenderRules(makeAlias());
		expect(rules).toEqual({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: [],
			blockedSenderAddresses: [],
			blockedSenderDomains: []
		});
		expect(evaluateSenderRules('anyone@example.com', makeAlias(), EMPTY_GLOBAL_BLOCKLIST).allowed)
			.toBe(true);
	});
});

describe('Email Worker precedence and compatibility', () => {
	it('forwards in normal mode and stores the normalized envelope sender', async () => {
		const { kv, forward, setReject } = await runEmail({ from: ' Sender@Example.COM ' });
		expect(forward).toHaveBeenCalledWith('inbox@example.net');
		expect(setReject).not.toHaveBeenCalled();
		expect(readLog(kv)[0].from).toBe('sender@example.com');
	});

	it('requires an allowlist match and never authorizes using the display From header', async () => {
		const alias = makeAlias({
			senderMode: 'allowlist',
			allowedSenderAddresses: ['trusted@example.com']
		});
		const { kv, forward, setReject } = await runEmail({
			alias,
			from: 'attacker@evil.example',
			headerFrom: 'Trusted <trusted@example.com>'
		});

		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Message rejected');
		expect(readLog(kv)[0].reason).toBe('sender_not_in_allowlist');
	});

	it('blocks global rules before alias rules', async () => {
		const { kv } = await runEmail({
			alias: makeAlias({ blockedSenderDomains: ['amazon.com'] }),
			from: 'orders@mail.amazon.com',
			globalBlocklist: { blockedSenderAddresses: [], blockedSenderDomains: ['amazon.com'] }
		});
		expect(readLog(kv)[0]).toMatchObject({
			reason: 'global_sender_blocked',
			matchedRule: 'amazon.com'
		});
	});

	it('blocks alias rules before alias allow rules', async () => {
		const { kv } = await runEmail({
			alias: makeAlias({
				senderMode: 'allowlist',
				allowedSenderDomains: ['amazon.com'],
				blockedSenderAddresses: ['orders@amazon.com']
			}),
			from: 'orders@amazon.com'
		});
		expect(readLog(kv)[0].reason).toBe('alias_sender_blocked');
	});

	it('uses the existing disabled state as block-all mode', async () => {
		const { kv, forward } = await runEmail({ alias: makeAlias({ enabled: false }) });
		expect(forward).not.toHaveBeenCalled();
		expect(readLog(kv)[0].reason).toBe('alias_disabled');
	});

	it('explicitly blocks a malformed or null envelope sender', async () => {
		const { kv, forward } = await runEmail({ from: null });
		expect(forward).not.toHaveBeenCalled();
		expect(readLog(kv)[0]).toMatchObject({ reason: 'invalid_sender', from: '' });
	});

	it('auto-creates wildcard aliases and forwards without a migration', async () => {
		const { kv, forward } = await runEmail({
			alias: null,
			domain: makeDomain({ wildcardEnabled: true }),
			to: 'new-alias@aliases.example.com'
		});
		expect(forward).toHaveBeenCalledOnce();
		const created = readAlias(kv, 'new-alias');
		expect(created).toMatchObject({ autoCreated: true, forwardedCount: 1, enabled: true });
		expect(created.senderMode).toBeUndefined();
	});

	it('preserves expiration behavior and records a stable reason', async () => {
		const { kv, forward } = await runEmail({ alias: makeAlias({ expiresAt: Date.now() - 1 }) });
		expect(forward).not.toHaveBeenCalled();
		expect(readAlias(kv).enabled).toBe(false);
		expect(readLog(kv)[0].reason).toBe('alias_expired');
	});

	it('preserves forwarding-limit behavior and records a stable reason', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ forwardedCount: 2, maxForwards: 2 })
		});
		expect(forward).not.toHaveBeenCalled();
		expect(readAlias(kv).enabled).toBe(false);
		expect(readLog(kv)[0].reason).toBe('forwarding_limit_reached');
	});

	it('preserves existing and unknown compatible alias fields on updates', async () => {
		const alias = {
			...makeAlias({ note: 'Keep me', tags: ['shopping'] }),
			futureCompatibleField: { enabled: true }
		} as AliasConfig;
		const { kv } = await runEmail({ alias });
		const updated = readAlias(kv) as AliasConfig & { futureCompatibleField: { enabled: boolean } };
		expect(updated.note).toBe('Keep me');
		expect(updated.tags).toEqual(['shopping']);
		expect(updated.futureCompatibleField).toEqual({ enabled: true });
	});
});

describe('bounded activity metadata and privacy', () => {
	it('stores truncated subject metadata and no body, raw message, headers, or attachments', async () => {
		const longSubject = `  ${'x'.repeat(230)} ignored-tail  `;
		const { kv, setReject } = await runEmail({
			alias: makeAlias({ blockedSenderDomains: ['example.com'] }),
			from: 'spam@example.com',
			subject: longSubject
		});
		const entry = readLog(kv)[0];
		const serialized = JSON.stringify(entry);

		expect(entry.reason).toBe('alias_sender_blocked');
		expect(Array.from(entry.subject ?? '')).toHaveLength(200);
		expect(Object.keys(entry).sort()).toEqual([
			'action', 'at', 'from', 'matchedRule', 'reason', 'recipient', 'subject', 'to'
		]);
		expect(serialized).not.toContain('body');
		expect(serialized).not.toContain('raw');
		expect(serialized).not.toContain('headers');
		expect(serialized).not.toContain('attachments');
		expect(setReject).toHaveBeenCalledWith('Message rejected');
		expect(setReject.mock.calls[0][0]).not.toContain(entry.subject);
	});

	it('sanitizes control characters and truncates by Unicode code point', () => {
		const subject = sanitizeSubject(` Hello\r\n${'🙂'.repeat(250)}`)!;
		expect(subject.startsWith('Hello ')).toBe(true);
		expect(Array.from(subject)).toHaveLength(200);
		expect(subject).not.toMatch(/[\r\n]/);
	});

	it('keeps only the newest 50 per-alias events', async () => {
		const kv = new MemoryKV();
		for (let at = 0; at < 51; at++) {
			await appendLog(kv as unknown as KVNamespace, 'aliases.example.com', 'orders', {
				at,
				action: 'blocked',
				from: 'sender@example.com',
				to: 'inbox@example.net',
				reason: 'alias_sender_blocked'
			});
		}
		const log = readLog(kv);
		expect(log).toHaveLength(50);
		expect(log[0].at).toBe(50);
		expect(log.at(-1)?.at).toBe(1);
	});
});
