import { describe, expect, it } from 'vitest';
import {
	MAX_CC_ADDRESSES,
	MAX_RULES_PER_LIST,
	MAX_SUBJECT_LENGTH,
	coerceSenderListInput,
	domainMatches,
	evaluateSenderRules,
	extractHeaderAddresses,
	normalizeDomain,
	normalizeEmailAddress,
	normalizeGlobalSenderBlocklist,
	normalizeSenderRules,
	sanitizeSubject,
	validateGlobalSenderBlocklist,
	validateSenderRules
} from '../../src/lib/sender-rules.js';
import { EMPTY_GLOBAL_BLOCKLIST, makeAlias } from './helpers.js';

describe('coerceSenderListInput', () => {
	it('splits a comma/whitespace-separated string into an array', () => {
		expect(coerceSenderListInput('a.com, b.com')).toEqual(['a.com', 'b.com']);
		expect(coerceSenderListInput('a.com,b.com  c.com')).toEqual(['a.com', 'b.com', 'c.com']);
	});

	it('returns an empty array for empty or whitespace-only strings', () => {
		expect(coerceSenderListInput('')).toEqual([]);
		expect(coerceSenderListInput('   ')).toEqual([]);
	});

	it('passes arrays and other types through unchanged', () => {
		const arr = ['a.com'];
		expect(coerceSenderListInput(arr)).toBe(arr);
		expect(coerceSenderListInput(undefined)).toBe(undefined);
		expect(coerceSenderListInput(42)).toBe(42);
	});
});

describe('normalizeDomain', () => {
	it('lowercases and trims valid domains', () => {
		expect(normalizeDomain('  Amazon.COM ')).toBe('amazon.com');
		expect(normalizeDomain('mail.sub.amazon.com')).toBe('mail.sub.amazon.com');
		expect(normalizeDomain('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com');
	});

	it.each([
		['non-string', 123],
		['empty', ''],
		['single label', 'localhost'],
		['double dot', 'a..b.com'],
		['trailing dot', 'example.com.'],
		['leading dot', '.example.com'],
		['label starting with hyphen', '-bad.com'],
		['label ending with hyphen', 'bad-.com'],
		['over 253 chars', `${'a'.repeat(250)}.com`]
	])('rejects a %s domain', (_label, value) => {
		expect(normalizeDomain(value)).toBeNull();
	});
});

describe('normalizeEmailAddress', () => {
	it('lowercases and trims valid addresses, including plus-tagging', () => {
		expect(normalizeEmailAddress('  User+Tag@Example.COM ')).toBe('user+tag@example.com');
		expect(normalizeEmailAddress("o'brien@example.com")).toBe("o'brien@example.com");
	});

	it('accepts a 64-char local part but rejects 65', () => {
		expect(normalizeEmailAddress(`${'a'.repeat(64)}@example.com`)).not.toBeNull();
		expect(normalizeEmailAddress(`${'a'.repeat(65)}@example.com`)).toBeNull();
	});

	it.each([
		['null', null],
		['no @', 'sender'],
		['double @', 'a@@example.com'],
		['leading @', '@example.com'],
		['trailing @', 'a@'],
		['display-name form', 'Alice <a@example.com>'],
		['dotted domain', 'a@fake..example'],
		['leading dot local', '.a@example.com'],
		['trailing dot local', 'a.@example.com'],
		['double dot local', 'a..b@example.com'],
		['space in local', 'a b@example.com'],
		['over 254 chars', `${'a'.repeat(250)}@example.com`]
	])('rejects a %s address', (_label, value) => {
		expect(normalizeEmailAddress(value)).toBeNull();
	});
});

describe('normalizeSenderRules', () => {
	it('defaults legacy aliases to normal mode with empty lists', () => {
		expect(normalizeSenderRules(makeAlias())).toEqual({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: [],
			blockedSenderAddresses: [],
			blockedSenderDomains: []
		});
	});

	it('preserves allowlist mode, drops invalid entries, and de-duplicates', () => {
		const rules = normalizeSenderRules({
			senderMode: 'allowlist',
			allowedSenderAddresses: ['A@Example.com', 'a@example.com', 'not-an-email'],
			blockedSenderDomains: ['Spam.com', 'spam.com', '*.wild.com']
		});
		expect(rules.senderMode).toBe('allowlist');
		expect(rules.allowedSenderAddresses).toEqual(['a@example.com']);
		expect(rules.blockedSenderDomains).toEqual(['spam.com']);
	});

	it('caps each list at MAX_RULES_PER_LIST', () => {
		const many = Array.from({ length: MAX_RULES_PER_LIST + 25 }, (_, i) => `u${i}@example.com`);
		expect(normalizeSenderRules({ blockedSenderAddresses: many }).blockedSenderAddresses)
			.toHaveLength(MAX_RULES_PER_LIST);
	});
});

describe('normalizeGlobalSenderBlocklist', () => {
	it('returns empty lists for null or non-object input', () => {
		expect(normalizeGlobalSenderBlocklist(null)).toEqual(EMPTY_GLOBAL_BLOCKLIST);
		expect(normalizeGlobalSenderBlocklist('nope')).toEqual(EMPTY_GLOBAL_BLOCKLIST);
	});

	it('normalizes and de-duplicates provided lists', () => {
		expect(normalizeGlobalSenderBlocklist({
			blockedSenderAddresses: ['X@Example.com', 'x@example.com'],
			blockedSenderDomains: ['Bad.com']
		})).toEqual({
			blockedSenderAddresses: ['x@example.com'],
			blockedSenderDomains: ['bad.com']
		});
	});
});

describe('validateSenderRules', () => {
	it('accepts well-formed rules and de-duplicates the stored value', () => {
		const result = validateSenderRules({
			senderMode: 'allowlist',
			allowedSenderAddresses: ['a@example.com', 'a@example.com'],
			allowedSenderDomains: [],
			blockedSenderAddresses: [],
			blockedSenderDomains: []
		});
		expect(result.ok).toBe(true);
		expect(result.value?.allowedSenderAddresses).toEqual(['a@example.com']);
	});

	it('rejects a non-object, a bad mode, a non-array list, and an oversized list', () => {
		expect(validateSenderRules(null).ok).toBe(false);
		expect(validateSenderRules({ senderMode: 'weird' }).ok).toBe(false);
		expect(validateSenderRules({
			senderMode: 'normal',
			allowedSenderAddresses: 'nope'
		}).ok).toBe(false);
		expect(validateSenderRules({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: [],
			blockedSenderAddresses: [],
			blockedSenderDomains: Array.from({ length: MAX_RULES_PER_LIST + 1 }, (_, i) => `d${i}.com`)
		}).ok).toBe(false);
	});

	it('reports the offending invalid entry', () => {
		const result = validateSenderRules({
			senderMode: 'normal',
			allowedSenderAddresses: [],
			allowedSenderDomains: ['https://example.com'],
			blockedSenderAddresses: [],
			blockedSenderDomains: []
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain('https://example.com');
	});
});

describe('validateGlobalSenderBlocklist', () => {
	it('accepts valid input and rejects non-objects and invalid entries', () => {
		expect(validateGlobalSenderBlocklist({
			blockedSenderAddresses: ['a@example.com'],
			blockedSenderDomains: ['bad.com']
		}).ok).toBe(true);
		expect(validateGlobalSenderBlocklist(null).ok).toBe(false);
		expect(validateGlobalSenderBlocklist({
			blockedSenderAddresses: ['not-an-email'],
			blockedSenderDomains: []
		}).ok).toBe(false);
	});
});

describe('domainMatches', () => {
	it('matches exact domains and true subdomains only on label boundaries', () => {
		expect(domainMatches('amazon.com', 'amazon.com')).toBe(true);
		expect(domainMatches('mail.amazon.com', 'amazon.com')).toBe(true);
		expect(domainMatches('fakeamazon.com', 'amazon.com')).toBe(false);
		expect(domainMatches('amazon.com.evil.example', 'amazon.com')).toBe(false);
	});
});

describe('evaluateSenderRules precedence', () => {
	it('rejects an unnormalizable envelope sender', () => {
		const decision = evaluateSenderRules('Alice <a@example.com>', makeAlias(), EMPTY_GLOBAL_BLOCKLIST);
		expect(decision).toEqual({ allowed: false, sender: null, reason: 'invalid_sender' });
	});

	it('allows any sender in normal mode', () => {
		expect(evaluateSenderRules('anyone@example.com', makeAlias(), EMPTY_GLOBAL_BLOCKLIST))
			.toMatchObject({ allowed: true, sender: 'anyone@example.com' });
	});

	it('applies global block > alias block > allowlist precedence', () => {
		const alias = makeAlias({
			senderMode: 'allowlist',
			allowedSenderDomains: ['amazon.com'],
			blockedSenderAddresses: ['orders@amazon.com']
		});

		expect(evaluateSenderRules('orders@amazon.com', alias, {
			blockedSenderAddresses: ['orders@amazon.com'],
			blockedSenderDomains: []
		})).toMatchObject({ reason: 'global_sender_blocked', matchedRule: 'orders@amazon.com' });

		expect(evaluateSenderRules('orders@amazon.com', alias, EMPTY_GLOBAL_BLOCKLIST))
			.toMatchObject({ reason: 'alias_sender_blocked' });
	});

	it('authorizes allowlist matches by address or by domain, and denies the rest', () => {
		const byAddress = makeAlias({ senderMode: 'allowlist', allowedSenderAddresses: ['ok@x.com'] });
		const byDomain = makeAlias({ senderMode: 'allowlist', allowedSenderDomains: ['x.com'] });
		expect(evaluateSenderRules('ok@x.com', byAddress, EMPTY_GLOBAL_BLOCKLIST).allowed).toBe(true);
		expect(evaluateSenderRules('anyone@mail.x.com', byDomain, EMPTY_GLOBAL_BLOCKLIST).allowed).toBe(true);
		expect(evaluateSenderRules('no@y.com', byDomain, EMPTY_GLOBAL_BLOCKLIST))
			.toMatchObject({ reason: 'sender_not_in_allowlist' });
	});

	it('never authorizes based on the display From header — only the envelope sender', () => {
		// The worker passes the envelope `message.from`; the display header is irrelevant here.
		const alias = makeAlias({ senderMode: 'allowlist', allowedSenderAddresses: ['trusted@example.com'] });
		expect(evaluateSenderRules('attacker@evil.example', alias, EMPTY_GLOBAL_BLOCKLIST).allowed)
			.toBe(false);
	});
});

describe('sanitizeSubject', () => {
	it('returns undefined for empty, missing, or control-only subjects', () => {
		expect(sanitizeSubject(null)).toBeUndefined();
		expect(sanitizeSubject('')).toBeUndefined();
		expect(sanitizeSubject('\r\n\t')).toBeUndefined();
	});

	it('strips control characters and collapses whitespace', () => {
		expect(sanitizeSubject('  Hello\r\n\tworld  ')).toBe('Hello world');
	});

	it('truncates by Unicode code point, not UTF-16 unit', () => {
		const subject = sanitizeSubject('🙂'.repeat(250))!;
		expect(Array.from(subject)).toHaveLength(MAX_SUBJECT_LENGTH);
	});
});

describe('extractHeaderAddresses', () => {
	it('returns an empty list for missing or address-free headers', () => {
		expect(extractHeaderAddresses(null)).toEqual([]);
		expect(extractHeaderAddresses('')).toEqual([]);
		expect(extractHeaderAddresses('undisclosed-recipients:;')).toEqual([]);
	});

	it('takes the address out of a display-name mailbox', () => {
		expect(extractHeaderAddresses('"Kadokawa, Store" <Shop@Kadokawa.co.JP>')).toEqual([
			'shop@kadokawa.co.jp'
		]);
		expect(extractHeaderAddresses('plain@example.com (Plain Sender)')).toEqual([
			'plain@example.com'
		]);
	});

	it('splits several mailboxes and drops duplicates and invalid ones', () => {
		expect(
			extractHeaderAddresses('a@example.com, A@example.com, not-an-address, <b@example.com>')
		).toEqual(['a@example.com', 'b@example.com']);
	});

	it('honors the address limit', () => {
		const header = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`).join(', ');
		expect(extractHeaderAddresses(header, 1)).toEqual(['user0@example.com']);
		expect(extractHeaderAddresses(header)).toHaveLength(MAX_CC_ADDRESSES);
	});
});

describe('sanitizeSubject decoding', () => {
	it('decodes encoded-words and still collapses whitespace', () => {
		expect(sanitizeSubject('=?UTF-8?Q?Order_shipped?=\r\n  today')).toBe('Order shipped today');
	});

	it('ignores non-string values from malformed storage', () => {
		expect(sanitizeSubject(42 as unknown as string)).toBeUndefined();
		expect(sanitizeSubject({} as unknown as string)).toBeUndefined();
	});

	it('strips control characters that a decoded subject can now smuggle in', () => {
		const rightToLeftOverride = String.fromCharCode(0x202e);
		const isolate = String.fromCharCode(0x2066);
		const nextLine = String.fromCharCode(0x0085);
		const decoded = sanitizeSubject(
			`Invoice ${rightToLeftOverride}moc.live@rekcatta${isolate}${nextLine}x`
		)!;
		expect(decoded).toBe('Invoice moc.live@rekcatta x');
		expect(decoded).not.toMatch(/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
	});

	it('keeps emoji sequences and right-to-left marks intact', () => {
		const zeroWidthJoiner = String.fromCharCode(0x200d);
		const rightToLeftMark = String.fromCharCode(0x200f);
		expect(sanitizeSubject(`a${zeroWidthJoiner}b${rightToLeftMark}c`)).toBe(
			`a${zeroWidthJoiner}b${rightToLeftMark}c`
		);
	});
});
