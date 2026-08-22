import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createSession, constantTimeEqual, COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '$lib/auth.js';

// Brute-force throttle: at most MAX_ATTEMPTS failed logins per IP per window.
const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.authenticated) throw redirect(302, '/');
	return { authMode: locals.authMode };
};

export const actions: Actions = {
	default: async ({ request, platform, cookies, getClientAddress }) => {
		const authPassword = platform?.env?.AUTH_PASSWORD;
		if (!authPassword) {
			return fail(400, { error: '尚未設定密碼驗證' });
		}

		const kv = platform?.env?.KV;
		let ip = 'unknown';
		try {
			ip = getClientAddress();
		} catch {
			ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
		}
		const attemptsKey = `login-attempts:${ip}`;

		let attempts = 0;
		if (kv) {
			attempts = Number(await kv.get(attemptsKey)) || 0;
			if (attempts >= MAX_ATTEMPTS) {
				return fail(429, { error: '嘗試次數過多，請稍後再試' });
			}
		}

		const data = await request.formData();
		const password = data.get('password');

		if (typeof password !== 'string' || !(await constantTimeEqual(password, authPassword))) {
			if (kv) {
				await kv.put(attemptsKey, String(attempts + 1), { expirationTtl: WINDOW_SECONDS });
			}
			return fail(401, { error: '密碼錯誤' });
		}

		if (kv) await kv.delete(attemptsKey);

		const sessionSecret = platform?.env?.SESSION_SECRET || authPassword;
		const sealed = await createSession(sessionSecret);

		cookies.set(COOKIE_NAME, sealed, SESSION_COOKIE_OPTIONS);

		throw redirect(302, '/');
	}
};
