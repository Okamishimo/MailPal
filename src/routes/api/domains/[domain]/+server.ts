import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDomain, putDomain } from '$lib/kv.js';
import { deleteDomainCascade } from '$lib/server/domain-cascade.js';

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export const GET: RequestHandler = async ({ params, locals }) => {
	const config = await getDomain(locals.kv, params.domain);
	if (!config) return json({ error: '找不到網域' }, { status: 404 });
	return json(config);
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const config = await getDomain(locals.kv, params.domain);
	if (!config) return json({ error: '找不到網域' }, { status: 404 });

	const body = await request.json();
	const { targetEmail, wildcardEnabled, enabled, color } = body;

	if (color !== undefined && color !== null && !HEX_COLOR_RE.test(color)) {
		return json({ error: '顏色值無效' }, { status: 400 });
	}

	const updated = {
		...config,
		...(targetEmail !== undefined && { targetEmail }),
		...(wildcardEnabled !== undefined && { wildcardEnabled }),
		...(enabled !== undefined && { enabled }),
		// null clears the custom color (reverts to auto); undefined means not sent
		...(color !== undefined && { color: color ?? undefined })
	};

	await putDomain(locals.kv, updated);
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const result = await deleteDomainCascade(locals.kv, params.domain);
	if (!result.found) {
		return json({ error: '找不到網域' }, { status: 404 });
	}

	return !result.complete
		? json({ pending: true }, { status: 202 })
		: new Response(null, { status: 204 });
};
