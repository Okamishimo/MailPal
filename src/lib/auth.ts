import { sealData, unsealData } from 'iron-session';

export const COOKIE_NAME = 'mailpal_session';

/**
 * Idle (sliding) session lifetime in seconds. The sealed token expires this long
 * after it was last issued; every authenticated request re-issues it (see
 * hooks.server.ts), so the window resets on activity and lapses after inactivity.
 */
export const SESSION_IDLE_TTL = 60 * 60; // 1 hour of inactivity

/**
 * Cookie attributes shared by login and the per-request sliding refresh.
 *
 * Deliberately omits `maxAge`/`expires`, making this a session cookie: the
 * browser drops it when it closes, so reopening the site requires a fresh login.
 * The 1-hour idle expiry is enforced server-side by the sealed token's TTL.
 */
export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: true,
	sameSite: 'lax'
} as const;

interface SessionData {
	authenticated: boolean;
}

/**
 * Derives a fixed-length (64 hex char) sealing key from an arbitrary secret.
 *
 * iron-session requires a key of at least 32 characters; feeding it a short
 * AUTH_PASSWORD directly would throw at runtime and break login. Hashing the
 * secret guarantees a valid-length key and decouples the sealing key from the
 * raw login password.
 */
async function deriveKey(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seals session data into an encrypted, authenticated token string.
 * Uses iron-session (AES-256-CBC + HMAC-SHA-256) which is compatible
 * with the Web Crypto API available in Cloudflare Workers.
 */
export async function createSession(secret: string): Promise<string> {
	const data: SessionData = { authenticated: true };
	return sealData(data, { password: await deriveKey(secret), ttl: SESSION_IDLE_TTL });
}

/**
 * Verifies a sealed session token and returns true if the session is valid.
 * Returns false for any invalid or tampered token.
 */
export async function verifySession(sealed: string | undefined, secret: string): Promise<boolean> {
	if (!sealed) return false;
	try {
		const data = await unsealData<SessionData>(sealed, {
			password: await deriveKey(secret),
			ttl: SESSION_IDLE_TTL
		});
		return data.authenticated === true;
	} catch {
		return false;
	}
}

/**
 * Verifies an `Authorization: Bearer <token>` header against the configured API
 * token, for automation clients (e.g. Apple Shortcuts) that cannot handle the
 * session-cookie login flow.
 *
 * Returns false when no token is configured, or the header is missing, not a
 * Bearer scheme, empty, or incorrect. The comparison is constant-time to avoid
 * leaking the token through timing.
 */
export async function verifyApiToken(
	authHeader: string | null,
	apiToken: string | undefined
): Promise<boolean> {
	if (!apiToken) return false;
	if (!authHeader?.startsWith('Bearer ')) return false;
	const provided = authHeader.slice('Bearer '.length);
	if (!provided) return false;
	return constantTimeEqual(provided, apiToken);
}

/**
 * Constant-time string equality. Both inputs are hashed to fixed-length digests
 * first, so neither the comparison time nor the input lengths leak information
 * about the secret. Prevents timing side-channels on the password check.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b))
	]);
	const va = new Uint8Array(ha);
	const vb = new Uint8Array(hb);
	let diff = 0;
	for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
	return diff === 0;
}
