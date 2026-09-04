import type { PageServerLoad } from './$types';
import { listRecentActivity, type ActivityEntry } from '$lib/server/activity.js';

export type { ActivityEntry };

export const load: PageServerLoad = async ({ locals }) => {
	// One ordered query replaces the old fan-out — listing every domain, then
	// every alias, then bulk-reading one log key per alias.
	const entries = await listRecentActivity(locals.kv, locals.db);
	return { entries, demo: locals.demo ?? false };
};
