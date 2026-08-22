import { describe, expect, it } from 'vitest';
import {
	MAX_RULES_PER_LIST,
	MAX_SUBJECT_LENGTH,
	domainMatches,
	evaluateSenderRules,
	normalizeDomain,
	normalizeEmailAddress,
	normalizeGlobalSenderBlocklist,
	normalizeSenderRules,
	sanitizeSubject,
	validateGlobalSenderBlocklist,
	validateSenderRules
} from '../../src/lib/sender-rules.js';
import { EMPTY_GLOBAL_BLOCKLIST, makeAlias } from './helpers.js';

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
