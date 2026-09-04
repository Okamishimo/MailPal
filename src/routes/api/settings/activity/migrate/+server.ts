import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { migrateLegacyActivity } from '$lib/server/activity.js';

/**
 * Move the legacy `log:` KV keys into D1, one bounded page per call.
 *
 * Optional housekeeping: the activity page reads both stores either way. Repeat
 * while the response is a 202.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (locals.demo) return json({ error: '展示模式不支援搬移活動紀錄' }, { status: 403 });
	if (!locals.db) {
		return json({ error: '尚未綁定 D1 資料庫，無需搬移活動紀錄' }, { status: 409 });
	}

	const result = await migrateLegacyActivity(locals.kv, locals.db);
	return result.complete
		? json({ ok: true, ...result })
		: json({ pending: true, ...result }, { status: 202 });
};
