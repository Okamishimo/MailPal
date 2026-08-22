import { describe, expect, it } from 'vitest';
import { normalizeTeamDomain, verifyAccessJwt } from '../../src/lib/access-jwt.js';

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'app-aud-tag';

function seg(obj: unknown): string {
	return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('normalizeTeamDomain', () => {
	it('strips scheme, trailing slashes, and surrounding whitespace', () => {
		expect(normalizeTeamDomain(`https://${TEAM}/`)).toBe(TEAM);
		expect(normalizeTeamDomain(`  ${TEAM} `)).toBe(TEAM);
		expect(normalizeTeamDomain(`http://${TEAM}///`)).toBe(TEAM);
	});
});

describe('verifyAccessJwt rejects invalid tokens without touching the network', () => {
	it('rejects a missing or empty token', async () => {
		expect(await verifyAccessJwt(null, TEAM, AUD)).toBe(false);
		expect(await verifyAccessJwt(undefined, TEAM, AUD)).toBe(false);
		expect(await verifyAccessJwt('', TEAM, AUD)).toBe(false);
	});

	it('rejects a token that is not three segments', async () => {
		expect(await verifyAccessJwt('only.two', TEAM, AUD)).toBe(false);
	});

	it('rejects a non-RS256 algorithm', async () => {
		const token = `${seg({ alg: 'none', kid: 'k1' })}.${seg({ aud: AUD })}.sig`;
		expect(await verifyAccessJwt(token, TEAM, AUD)).toBe(false);
	});

	it('rejects a header missing a key id', async () => {
		const token = `${seg({ alg: 'RS256' })}.${seg({ aud: AUD })}.sig`;
		expect(await verifyAccessJwt(token, TEAM, AUD)).toBe(false);
	});

	it('rejects a completely malformed header segment', async () => {
		expect(await verifyAccessJwt('!!!.###.$$$', TEAM, AUD)).toBe(false);
	});
});
