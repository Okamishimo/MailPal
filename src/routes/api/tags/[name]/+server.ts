import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTag, putTag } from '$lib/kv.js';
import { deleteTagCascade } from '$lib/server/tag-cascade.js';
import type { Tag } from '$lib/types.js';

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const tag = await getTag(locals.kv, params.name);
	if (!tag) return json({ error: '找不到標籤' }, { status: 404 });

	const body = await request.json().catch(() => ({}));
	const { color } = body as { color?: string };

	if (color !== undefined && !HEX_COLOR_RE.test(color)) {
		return json({ error: '顏色值無效' }, { status: 400 });
	}

	const updated: Tag = { ...tag, ...(color !== undefined && { color }) };
	await putTag(locals.kv, updated);
	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const result = await deleteTagCascade(locals.kv, params.name);
	if (!result.found) {
		return json({ error: '找不到標籤' }, { status: 404 });
	}

	return !result.complete
		? json({ pending: true }, { status: 202 })
		: new Response(null, { status: 204 });
};
