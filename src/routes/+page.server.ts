import type { PageServerLoad } from './$types';
import {
	getGlobalSenderBlocklist,
	listDomains,
	listAliases,
	listDestinations,
	listTags
} from '$lib/kv.js';

export const load: PageServerLoad = async ({ locals }) => {
	const [domains, destinations, tags, onboardedFlag, globalSenderBlocklist] = await Promise.all([
		listDomains(locals.kv),
		listDestinations(locals.kv),
		listTags(locals.kv),
		locals.kv.get('settings:onboarded'),
		getGlobalSenderBlocklist(locals.kv)
	]);

	domains.sort((a, b) => a.createdAt - b.createdAt);
	destinations.sort((a, b) => a.createdAt - b.createdAt);
	tags.sort((a, b) => a.createdAt - b.createdAt);

	const allAliases = (await Promise.all(domains.map((d) => listAliases(locals.kv, d.domain)))).flat();
	allAliases.sort((a, b) => b.createdAt - a.createdAt);

	return {
		domains,
		allAliases,
		destinations,
		tags,
		globalSenderBlocklist,
		onboarded: onboardedFlag === '1',
		demo: locals.demo ?? false
	};
};
