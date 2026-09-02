import { redirect, type Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { createSession, verifySession, verifyApiToken, COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '$lib/auth.js';
import { verifyAccessJwt } from '$lib/access-jwt.js';
import { DemoKV, type DemoDelta } from '$lib/demo-kv.js';

const DEMO_STATE_COOKIE = 'demo_state';

const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

export const handle: Handle = async ({ event, resolve }) => {
	const platform = event.platform;
	const demoMode = platform?.env?.DEMO_MODE;
 	const isDemoModeEnabled = demoMode === '1' || demoMode === 'true';

	// ── Demo mode ───────────────────────────────────────────────────────────
	if (isDemoModeEnabled) {
		// Restore any previously saved mutations from the browser cookie.
		let savedDelta: DemoDelta | undefined;
		const raw = event.cookies.get(DEMO_STATE_COOKIE);
		if (raw) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (
					typeof parsed === 'object' &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					savedDelta = parsed as DemoDelta;
				}
			} catch {
				// ignore corrupt cookie — fall back to default seed data
			}
		}

		const demoKV = new DemoKV(savedDelta);
		event.locals.kv = demoKV as unknown as App.Locals['kv'];
		event.locals.demo = true;
		event.locals.authenticated = true;
		event.locals.authMode = 'cloudflare-access';
		const response = await resolve(event);

		// Persist the accumulated delta back to the browser so the next request
		// (and localStorage — see +layout.svelte) picks up all mutations.
		const deltaJson = JSON.stringify(demoKV.getDelta());
		response.headers.append(
			'Set-Cookie',
			`${DEMO_STATE_COOKIE}=${encodeURIComponent(deltaJson)}; Path=/; SameSite=Lax; Max-Age=604800; Secure`
		);

		for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
			response.headers.set(key, value);
		}
		return response;
	}

	if (!platform?.env?.KV) {
		// Local dev without wrangler: allow through so the UI is workable.
		// In production a missing KV binding must FAIL CLOSED — otherwise a
		// misconfigured deployment would silently disable all authentication.
		if (!dev) {
			return new Response('Service unavailable', {
				status: 503,
				headers: SECURITY_HEADERS
			});
		}
		event.locals.authMode = 'cloudflare-access';
		event.locals.authenticated = true;
		const response = await resolve(event);
		for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
			response.headers.set(key, value);
		}
		return response;
	}

	event.locals.kv = platform.env.KV;
	// Optional: activity falls back to the legacy `log:` KV keys when unbound.
	event.locals.db = platform.env.DB;

	const authPassword = platform.env.AUTH_PASSWORD;
	event.locals.authMode = authPassword ? 'password' : 'cloudflare-access';

	const pathname = event.url.pathname;
	const isLoginRoute = pathname === '/login';
	const isApiRoute = pathname.startsWith('/api/');

	// API token auth for automation (e.g. Apple Shortcuts). Deliberately scoped to
	// /api/ routes only, so a leaked token can never reach the HTML dashboard. When
	// it matches we skip the session/Access checks entirely — including the
	// sliding-cookie refresh, which is meaningless for a cookie-less client.
	if (
		isApiRoute &&
		(await verifyApiToken(event.request.headers.get('Authorization'), platform.env.API_TOKEN))
	) {
		event.locals.authenticated = true;
		event.locals.apiTokenAuthenticated = true;
	} else if (event.locals.authMode === 'cloudflare-access') {
		const teamDomain = platform.env.CF_ACCESS_TEAM_DOMAIN;
		const aud = platform.env.CF_ACCESS_AUD;
		if (teamDomain && aud) {
			// Cryptographically verify the Access JWT instead of trusting placement.
			const token = event.request.headers.get('Cf-Access-Jwt-Assertion');
			event.locals.authenticated = await verifyAccessJwt(token, teamDomain, aud);
		} else {
			// No Access verification configured: trust that Cloudflare Access is
			// enforced in front of this origin. Set CF_ACCESS_TEAM_DOMAIN and
			// CF_ACCESS_AUD to have the app verify the Access JWT itself.
			if (!dev) {
				console.warn(JSON.stringify({
					message:
						'cloudflare-access mode without CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD — Access JWT is not being verified'
				}));
			}
			event.locals.authenticated = true;
		}
	} else {
		const sealed = event.cookies.get(COOKIE_NAME);
		const sessionSecret = platform.env.SESSION_SECRET || authPassword!;
		event.locals.authenticated = await verifySession(sealed, sessionSecret);

		// Sliding idle timeout: re-issue the token on every authenticated request
		// so the 1-hour expiry resets on activity. After an hour of inactivity the
		// token lapses, verifySession fails, and the user is sent back to /login.
		if (event.locals.authenticated) {
			const refreshed = await createSession(sessionSecret);
			event.cookies.set(COOKIE_NAME, refreshed, SESSION_COOKIE_OPTIONS);
		}
	}

	if (!event.locals.authenticated && !isLoginRoute) {
		if (isApiRoute) {
			return new Response(JSON.stringify({ error: '未授權' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json', ...SECURITY_HEADERS }
			});
		}
		// In cloudflare-access mode there is no password login page to send the
		// user to, so a failed check is a hard 403 rather than a redirect loop.
		if (event.locals.authMode === 'cloudflare-access') {
			return new Response('Forbidden', { status: 403, headers: SECURITY_HEADERS });
		}
		throw redirect(302, '/login');
	}

	if (event.locals.authenticated && isLoginRoute) {
		throw redirect(302, '/');
	}

	const response = await resolve(event);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(key, value);
	}
	return response;
};
