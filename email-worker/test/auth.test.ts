import { describe, expect, it } from 'vitest';
import { constantTimeEqual, createSession, verifySession } from '../../src/lib/auth.js';

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
