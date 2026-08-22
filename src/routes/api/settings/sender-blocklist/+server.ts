import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getGlobalSenderBlocklist, putGlobalSenderBlocklist } from '$lib/kv.js';
import { validateGlobalSenderBlocklist } from '$lib/sender-rules.js';

export const GET: RequestHandler = async ({ locals }) => {
	return json(await getGlobalSenderBlocklist(locals.kv));
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	const body: unknown = await request.json().catch(() => null);
	const result = validateGlobalSenderBlocklist(body);
	if (!result.ok) return json({ error: result.error }, { status: 400 });

	await putGlobalSenderBlocklist(locals.kv, result.value!);
	return json(result.value);
};
