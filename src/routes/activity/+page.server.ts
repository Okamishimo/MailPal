import type { PageServerLoad } from './$types';
import { listDomains, listAliases, getLogs } from '$lib/kv.js';
import type { LogEntry } from '$lib/types.js';

export interface ActivityEntry extends LogEntry {
	localPart: string;
	domain: string;
}

export const load: PageServerLoad = async ({ locals }) => {
	const domains = await listDomains(locals.kv);
	const allAliases = (await Promise.all(domains.map((d) => listAliases(locals.kv, d.domain)))).flat();

	const logs = await getLogs(locals.kv, allAliases);
	const buckets = allAliases.map((alias, index) =>
		logs[index].map((entry): ActivityEntry => ({
			...entry,
			localPart: alias.localPart,
			domain: alias.domain
		}))
	);

	const entries = buckets.flat().sort((a, b) => b.at - a.at).slice(0, 200);
	return { entries, demo: locals.demo ?? false };
};
