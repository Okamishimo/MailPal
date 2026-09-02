import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAlias } from '$lib/kv.js';
import { listAliasActivity } from '$lib/server/activity.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const alias = await getAlias(locals.kv, params.domain, params.localPart);
	if (!alias) return json({ error: '找不到別名' }, { status: 404 });

	const log = await listAliasActivity(locals.kv, locals.db, params.domain, params.localPart);
	return json(log);
};
