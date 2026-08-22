import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDomain, listDomains, putDomain } from '$lib/kv.js';
import type { DomainConfig } from '$lib/types.js';

// RFC 1123 hostname validation (does not allow bare TLDs)
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET: RequestHandler = async ({ locals }) => {
	const domains = await listDomains(locals.kv);
	domains.sort((a, b) => a.createdAt - b.createdAt);
	return json(domains);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const { domain, targetEmail, wildcardEnabled = false, color } = body as Partial<DomainConfig>;

	if (!domain || !targetEmail) {
		return json({ error: '網域與轉寄地址為必填欄位' }, { status: 400 });
	}

	// The email worker lowercases the recipient domain before lookup, so domains
	// must be stored lowercase or mail to them would never match.
	const normalizedDomain = domain.trim().toLowerCase();
	if (!DOMAIN_RE.test(normalizedDomain)) {
		return json({ error: '網域名稱無效' }, { status: 400 });
	}

	if (!EMAIL_RE.test(targetEmail)) {
		return json({ error: '轉寄地址無效' }, { status: 400 });
	}

	if (color !== undefined && color !== null && !HEX_COLOR_RE.test(color)) {
		return json({ error: '顏色值無效' }, { status: 400 });
	}

	const existing = await getDomain(locals.kv, normalizedDomain);
	if (existing) {
		return json({ error: '此網域已存在' }, { status: 409 });
	}

	const config: DomainConfig = {
		domain: normalizedDomain,
		targetEmail,
		wildcardEnabled: wildcardEnabled ?? false,
		enabled: true,
		createdAt: Date.now(),
		...(color && { color })
	};

	await putDomain(locals.kv, config);
	return json(config, { status: 201 });
};
