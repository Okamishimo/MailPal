import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDomain, getAlias, listAliases, putAlias } from '$lib/kv.js';
import { generateSlug } from '$lib/sluggen.js';
import type { AliasConfig } from '$lib/types.js';
import { normalizeSenderRules, validateSenderRules } from '$lib/sender-rules.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET: RequestHandler = async ({ params, locals }) => {
	const domainName = params.domain.toLowerCase();
	const domain = await getDomain(locals.kv, domainName);
	if (!domain) return json({ error: '找不到網域' }, { status: 404 });

	const aliases = await listAliases(locals.kv, domainName);
	aliases.sort((a, b) => a.createdAt - b.createdAt);
	return json(aliases);
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const domainName = params.domain.toLowerCase();
	const domain = await getDomain(locals.kv, domainName);
	if (!domain) return json({ error: '找不到網域' }, { status: 404 });

	const body = await request.json().catch(() => ({})) as Record<string, unknown>;
	let { localPart, targetEmail = null, note, tags, expiresAt, maxForwards } = body as { localPart?: string; targetEmail?: string | null; note?: string; tags?: string[]; expiresAt?: number; maxForwards?: number };
	const senderRuleFields = [
		'senderMode',
		'allowedSenderAddresses',
		'allowedSenderDomains',
		'blockedSenderAddresses',
		'blockedSenderDomains'
	] as const;
	let senderRules = null;
	if (senderRuleFields.some((field) => field in body)) {
		const result = validateSenderRules({
			...normalizeSenderRules(null),
			...Object.fromEntries(
				senderRuleFields
					.filter((field) => field in body)
					.map((field) => [field, body[field]])
			)
		});
		if (!result.ok) return json({ error: result.error }, { status: 400 });
		senderRules = result.value!;
	}

	if (targetEmail != null && !EMAIL_RE.test(targetEmail)) {
		return json({ error: '轉寄地址無效' }, { status: 400 });
	}

	if (!localPart) {
		// Auto-generate unique slug
		let attempts = 0;
		do {
			localPart = generateSlug();
			attempts++;
		} while ((await getAlias(locals.kv, domainName, localPart)) && attempts < 10);
	} else {
		// Validate local part
		if (!/^[a-zA-Z0-9._+-]+$/.test(localPart)) {
			return json({ error: '別名名稱無效' }, { status: 400 });
		}
		if (localPart.length > 64) {
			return json({ error: '別名名稱不可超過 64 個字元' }, { status: 400 });
		}
		// The email worker lowercases the recipient local part before lookup, so
		// aliases must be stored lowercase or they would never receive mail.
		localPart = localPart.toLowerCase();
		const existing = await getAlias(locals.kv, domainName, localPart);
		if (existing) return json({ error: '此別名已存在' }, { status: 409 });
	}

	const config: AliasConfig = {
		localPart,
		domain: domainName,
		targetEmail: targetEmail ?? null,
		enabled: true,
		createdAt: Date.now(),
		forwardedCount: 0,
		blockedCount: 0,
		lastUsedAt: null,
		autoCreated: false,
		...(note && { note }),
		...(tags && { tags }),
		...(expiresAt != null && { expiresAt }),
		...(maxForwards != null && { maxForwards }),
		...(senderRules ?? {})
	};

	await putAlias(locals.kv, config);
	return json(config, { status: 201 });
};
