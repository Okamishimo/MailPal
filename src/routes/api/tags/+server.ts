import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTag, listTags, putTag } from '$lib/kv.js';
import type { Tag } from '$lib/types.js';

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const TAG_NAME_MAX_LENGTH = 50;

export const GET: RequestHandler = async ({ locals }) => {
	const tags = await listTags(locals.kv);
	tags.sort((a, b) => a.createdAt - b.createdAt);
	return json(tags);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json().catch(() => ({}));
	const { name, color } = body as { name?: string; color?: string };

	if (!name || !name.trim()) {
		return json({ error: '請輸入標籤名稱' }, { status: 400 });
	}

	const trimmedName = name.trim();
	if (trimmedName.length > TAG_NAME_MAX_LENGTH) {
		return json({ error: `標籤名稱不可超過 ${TAG_NAME_MAX_LENGTH} 個字元` }, { status: 400 });
	}

	if (color !== undefined && !HEX_COLOR_RE.test(color)) {
		return json({ error: '顏色值無效' }, { status: 400 });
	}

	const existing = await getTag(locals.kv, trimmedName);
	if (existing?.pendingDelete) {
		// Re-creating it now would resurrect a name a cascade is still stripping
		// from aliases, so the retry has to finish first.
		return json({ error: '此標籤正在刪除中，請稍後再試' }, { status: 409 });
	}
	if (existing) return json({ error: '此標籤已存在' }, { status: 409 });

	const tag: Tag = {
		name: trimmedName,
		color: color ?? '#3b82f6',
		createdAt: Date.now()
	};

	await putTag(locals.kv, tag);
	return json(tag, { status: 201 });
};
