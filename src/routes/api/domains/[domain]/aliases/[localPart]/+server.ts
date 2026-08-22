import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteAlias, deleteLog, getAlias, putAlias } from '$lib/kv.js';
import { normalizeSenderRules, validateSenderRules } from '$lib/sender-rules.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const alias = await getAlias(locals.kv, params.domain, params.localPart);
	if (!alias) return json({ error: '找不到別名' }, { status: 404 });
	return json(alias);
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const alias = await getAlias(locals.kv, params.domain, params.localPart);
	if (!alias) return json({ error: '找不到別名' }, { status: 404 });

	const body = await request.json().catch(() => null) as Record<string, unknown> | null;
	if (!body) return json({ error: 'JSON 內容無效' }, { status: 400 });
	const { enabled, targetEmail, note, tags, expiresAt, maxForwards } = body;

	const updated = { ...alias };
	if (enabled !== undefined) {
		if (typeof enabled !== 'boolean') return json({ error: 'enabled 必須是布林值' }, { status: 400 });
		updated.enabled = enabled;
	}
	if (targetEmail !== undefined) {
		if (targetEmail !== null && typeof targetEmail !== 'string') {
			return json({ error: 'targetEmail 必須是字串或 null' }, { status: 400 });
		}
		updated.targetEmail = targetEmail === '' ? null : targetEmail;
	}
	if (note !== undefined) {
		if (note !== null && typeof note !== 'string') return json({ error: 'note 必須是字串或 null' }, { status: 400 });
		updated.note = note || undefined;
	}
	if (tags !== undefined) {
		if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
			return json({ error: 'tags 必須是字串陣列' }, { status: 400 });
		}
		updated.tags = tags as string[];
	}
	if (expiresAt !== undefined) {
		if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
			return json({ error: 'expiresAt 必須是數字或 null' }, { status: 400 });
		}
		updated.expiresAt = expiresAt ?? undefined;
	}
	if (maxForwards !== undefined) {
		if (maxForwards !== null && (typeof maxForwards !== 'number' || !Number.isInteger(maxForwards) || maxForwards < 1)) {
			return json({ error: 'maxForwards 必須是正整數或 null' }, { status: 400 });
		}
		updated.maxForwards = maxForwards ?? undefined;
	}

	const senderRuleFields = [
		'senderMode',
		'allowedSenderAddresses',
		'allowedSenderDomains',
		'blockedSenderAddresses',
		'blockedSenderDomains'
	] as const;
	if (senderRuleFields.some((field) => field in body)) {
		const rules = validateSenderRules({
			...normalizeSenderRules(alias),
			...Object.fromEntries(
				senderRuleFields
					.filter((field) => field in body)
					.map((field) => [field, body[field]])
			)
		});
		if (!rules.ok) return json({ error: rules.error }, { status: 400 });
		Object.assign(updated, rules.value);
	}

	await putAlias(locals.kv, updated);
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const alias = await getAlias(locals.kv, params.domain, params.localPart);
	if (!alias) return json({ error: '找不到別名' }, { status: 404 });

	await Promise.all([
		deleteAlias(locals.kv, params.domain, params.localPart),
		deleteLog(locals.kv, params.domain, params.localPart)
	]);
	return new Response(null, { status: 204 });
};
