import { sealData, unsealData } from 'iron-session';

export const COOKIE_NAME = 'mailpal_session';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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
	return sealData(data, { password: await deriveKey(secret), ttl: COOKIE_MAX_AGE });
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
			ttl: COOKIE_MAX_AGE
		});
		return data.authenticated === true;
	} catch {
		return false;
	}
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
