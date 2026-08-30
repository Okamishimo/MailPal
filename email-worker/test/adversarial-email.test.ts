import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CC_ADDRESSES, MAX_SUBJECT_LENGTH } from '../../src/lib/sender-rules.js';
import { makeAlias, readLog, runEmail } from './helpers.js';

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('adversarial email headers', () => {
	it('does not let a spoofed From header satisfy the envelope-sender allowlist', async () => {
		const { kv, forward, setReject } = await runEmail({
			alias: makeAlias({
				senderMode: 'allowlist',
				allowedSenderAddresses: ['security@trusted.example']
			}),
			from: 'attacker@evil.example',
			headerFrom: 'Trusted Security <security@trusted.example>'
		});

		expect(forward).not.toHaveBeenCalled();
		expect(setReject).toHaveBeenCalledWith('Message rejected');
		expect(readLog(kv)[0]).toMatchObject({
			action: 'blocked',
			reason: 'sender_not_in_allowlist',
			from: 'attacker@evil.example',
			headerFrom: 'security@trusted.example'
		});
	});

	it('does not let a benign-looking From header evade an envelope-sender block', async () => {
		const { kv, forward } = await runEmail({
			alias: makeAlias({ blockedSenderDomains: ['evil.example'] }),
			from: 'attacker@sub.evil.example',
			headerFrom: 'Billing <billing@trusted.example>'
		});

		expect(forward).not.toHaveBeenCalled();
		expect(readLog(kv)[0]).toMatchObject({
			reason: 'alias_sender_blocked',
			from: 'attacker@sub.evil.example',
			headerFrom: 'billing@trusted.example'
		});
	});

	it('rejects an invalid envelope sender even when From looks trustworthy', async () => {
		const { kv, forward } = await runEmail({
			from: null,
			headerFrom: 'Security <security@trusted.example>'
		});

		expect(forward).not.toHaveBeenCalled();
		expect(readLog(kv)[0]).toMatchObject({
			reason: 'invalid_sender',
			from: '',
			headerFrom: 'security@trusted.example'
		});
	});

	it('neutralizes encoded CRLF and NUL bytes without interpreting HTML-looking text', async () => {
		const { kv, forward } = await runEmail({
			subject:
				'=?UTF-8?B?SW52b2ljZQ0KWC1Gb3JnZWQ6IHllcwA8c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+?='
		});

		expect(forward).toHaveBeenCalledOnce();
		const subject = readLog(kv)[0].subject;
		expect(subject).toBe('Invoice X-Forged: yes <script>alert(1)</script>');
		expect(subject).not.toMatch(/[\u0000-\u001f\u007f]/);
	});

	it('bounds attacker-controlled subject and Cc metadata', async () => {
		const cc = Array.from({ length: 300 }, (_, index) => `user${index}@evil.example`).join(', ');
		const { kv, forward } = await runEmail({
			subject: 'A'.repeat(50_000),
			cc
		});

		expect(forward).toHaveBeenCalledOnce();
		const entry = readLog(kv)[0];
		expect(Array.from(entry.subject ?? '')).toHaveLength(MAX_SUBJECT_LENGTH);
		expect(entry.cc).toHaveLength(MAX_CC_ADDRESSES);
		expect(entry.cc).toEqual([
			'user0@evil.example',
			'user1@evil.example',
			'user2@evil.example',
			'user3@evil.example',
			'user4@evil.example'
		]);
	});

	it('survives malformed encoded-words and address-list noise', async () => {
		const { kv, forward, setReject } = await runEmail({
			subject: '=?UTF-8?Q?=ZZ?=',
			headerFrom: 'not-an-address',
			cc: 'safe@example.com, definitely-not-an-address, <second@example.org>'
		});

		expect(forward).toHaveBeenCalledOnce();
		expect(setReject).not.toHaveBeenCalled();
		expect(readLog(kv)[0]).toMatchObject({
			subject: '=?UTF-8?Q?=ZZ?=',
			cc: ['safe@example.com', 'second@example.org']
		});
		expect(readLog(kv)[0].headerFrom).toBeUndefined();
	});
});
