import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SESSION_COOKIE_OPTIONS,
	SESSION_IDLE_TTL,
	constantTimeEqual,
	createSession,
	verifySession
} from '../../src/lib/auth.js';

describe('constantTimeEqual', () => {
	it('matches equal strings and rejects differing ones, including different lengths', async () => {
		expect(await constantTimeEqual('correct horse', 'correct horse')).toBe(true);
		expect(await constantTimeEqual('secret', 'Secret')).toBe(false);
		expect(await constantTimeEqual('secret', 'secret-longer')).toBe(false);
		expect(await constantTimeEqual('', '')).toBe(true);
	});
});

describe('session sealing round-trip', () => {
	it('accepts a token sealed and verified with the same secret', async () => {
		const sealed = await createSession('a-reasonably-long-secret-value');
		expect(await verifySession(sealed, 'a-reasonably-long-secret-value')).toBe(true);
	});

	it('works with a short secret (regression: must not throw on <32 chars)', async () => {
		const sealed = await createSession('short');
		expect(await verifySession(sealed, 'short')).toBe(true);
	});

	it('rejects a token verified with a different secret', async () => {
		const sealed = await createSession('secret-a');
		expect(await verifySession(sealed, 'secret-b')).toBe(false);
	});

	it('rejects a missing or tampered token', async () => {
		expect(await verifySession(undefined, 'secret')).toBe(false);
		expect(await verifySession('not-a-valid-sealed-token', 'secret')).toBe(false);
	});
});

describe('session cookie configuration', () => {
	it('uses a one-hour idle TTL', () => {
		expect(SESSION_IDLE_TTL).toBe(60 * 60);
	});

	it('is a hardened session cookie with no persistent lifetime', () => {
		expect(SESSION_COOKIE_OPTIONS).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
		// A session cookie must omit maxAge/expires so the browser clears it on
		// close, forcing a fresh login when the site is reopened.
		expect('maxAge' in SESSION_COOKIE_OPTIONS).toBe(false);
		expect('expires' in SESSION_COOKIE_OPTIONS).toBe(false);
	});
});

describe('session idle expiry (sliding window)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('accepts a token used within the idle window', async () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const sealed = await createSession('a-reasonably-long-secret-value');

		// 30 minutes later — still inside the 1-hour window.
		vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
		expect(await verifySession(sealed, 'a-reasonably-long-secret-value')).toBe(true);
	});

	it('rejects a token after the idle window lapses', async () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		const sealed = await createSession('a-reasonably-long-secret-value');

		// 2 hours later — well past the 1-hour idle TTL.
		vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
		expect(await verifySession(sealed, 'a-reasonably-long-secret-value')).toBe(false);
	});
});
