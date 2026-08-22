/**
 * Verifies a Cloudflare Access application JWT (the `Cf-Access-Jwt-Assertion`
 * header Access injects on every authenticated request).
 *
 * This is only used when both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are
 * configured. When they are, the dashboard cryptographically verifies the token
 * instead of blindly trusting that Access is enforced in front of the origin —
 * closing the gap where anyone able to reach the origin directly would
 * otherwise gain full admin access.
 */

type AccessJwk = JsonWebKey & { kid?: string };

interface CertsResponse {
	keys?: AccessJwk[];
}

interface CachedKeys {
	teamDomain: string;
	keys: Map<string, CryptoKey>;
	fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // Refresh Access signing keys hourly.
let cache: CachedKeys | null = null;

function base64UrlDecode(input: string): Uint8Array {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeSegment(segment: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

export function normalizeTeamDomain(teamDomain: string): string {
	return teamDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
	if (cache && cache.teamDomain === teamDomain && Date.now() - cache.fetchedAt < JWKS_TTL_MS) {
		return cache.keys;
	}

	const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Failed to fetch Access certs: ${res.status}`);

	const body = (await res.json()) as CertsResponse;
	const keys = new Map<string, CryptoKey>();
	for (const jwk of body.keys ?? []) {
		if (!jwk.kid) continue;
		const key = await crypto.subtle.importKey(
			'jwk',
			{ ...jwk, alg: 'RS256', ext: true },
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify']
		);
		keys.set(jwk.kid, key);
	}

	cache = { teamDomain, keys, fetchedAt: Date.now() };
	return keys;
}

export async function verifyAccessJwt(
	token: string | null | undefined,
	teamDomainRaw: string,
	aud: string
): Promise<boolean> {
	if (!token) return false;
	try {
		const teamDomain = normalizeTeamDomain(teamDomainRaw);
		const parts = token.split('.');
		if (parts.length !== 3) return false;
		const [headerB64, payloadB64, signatureB64] = parts;

		const header = decodeSegment(headerB64) as { kid?: string; alg?: string };
		if (header.alg !== 'RS256' || !header.kid) return false;

		const keys = await loadKeys(teamDomain);
		const key = keys.get(header.kid);
		if (!key) return false;

		const signature = base64UrlDecode(signatureB64);
		const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
		const valid = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			signature as BufferSource,
			signed as BufferSource
		);
		if (!valid) return false;

		const payload = decodeSegment(payloadB64) as {
			aud?: string | string[];
			exp?: number;
			nbf?: number;
			iss?: string;
		};

		const now = Math.floor(Date.now() / 1000);
		if (typeof payload.exp !== 'number' || payload.exp < now) return false;
		if (typeof payload.nbf === 'number' && payload.nbf > now) return false;

		const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
		if (!audiences.includes(aud)) return false;

		if (payload.iss && payload.iss !== `https://${teamDomain}`) return false;

		return true;
	} catch {
		return false;
	}
}
