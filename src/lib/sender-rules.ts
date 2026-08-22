import type {
	AliasConfig,
	BlockReason,
	GlobalSenderBlocklist,
	SenderMode,
	SenderRuleFields
} from './types.js';

export const MAX_RULES_PER_LIST = 200;
export const MAX_SUBJECT_LENGTH = 200;

const LOCAL_PART_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface NormalizedSenderRules {
	senderMode: SenderMode;
	allowedSenderAddresses: string[];
	allowedSenderDomains: string[];
	blockedSenderAddresses: string[];
	blockedSenderDomains: string[];
}

export interface SenderDecision {
	allowed: boolean;
	sender: string | null;
	reason?: BlockReason;
	matchedRule?: string;
}

export interface SenderRuleValidationResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

export function normalizeDomain(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const domain = value.trim().toLowerCase();
	if (domain.length === 0 || domain.length > 253 || domain.includes('..')) return null;

	const labels = domain.split('.');
	if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL_RE.test(label))) return null;
	return domain;
}

export function normalizeEmailAddress(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const address = value.trim().toLowerCase();
	if (address.length === 0 || address.length > 254) return null;

	const at = address.indexOf('@');
	if (at <= 0 || at !== address.lastIndexOf('@')) return null;

	const localPart = address.slice(0, at);
	const domain = normalizeDomain(address.slice(at + 1));
	if (
		!domain ||
		localPart.length > 64 ||
		localPart.startsWith('.') ||
		localPart.endsWith('.') ||
		localPart.includes('..') ||
		!LOCAL_PART_RE.test(localPart)
	) {
		return null;
	}

	return `${localPart}@${domain}`;
}

function normalizeStoredList(value: unknown, kind: 'address' | 'domain'): string[] {
	if (!Array.isArray(value)) return [];
	const normalize = kind === 'address' ? normalizeEmailAddress : normalizeDomain;
	const normalized = value
		.map((entry) => normalize(entry))
		.filter((entry): entry is string => entry !== null);
	return [...new Set(normalized)].slice(0, MAX_RULES_PER_LIST);
}

export function normalizeSenderRules(rules: SenderRuleFields | null | undefined): NormalizedSenderRules {
	return {
		senderMode: rules?.senderMode === 'allowlist' ? 'allowlist' : 'normal',
		allowedSenderAddresses: normalizeStoredList(rules?.allowedSenderAddresses, 'address'),
		allowedSenderDomains: normalizeStoredList(rules?.allowedSenderDomains, 'domain'),
		blockedSenderAddresses: normalizeStoredList(rules?.blockedSenderAddresses, 'address'),
		blockedSenderDomains: normalizeStoredList(rules?.blockedSenderDomains, 'domain')
	};
}

export function normalizeGlobalSenderBlocklist(value: unknown): GlobalSenderBlocklist {
	const input = value && typeof value === 'object' ? value as Partial<GlobalSenderBlocklist> : {};
	return {
		blockedSenderAddresses: normalizeStoredList(input.blockedSenderAddresses, 'address'),
		blockedSenderDomains: normalizeStoredList(input.blockedSenderDomains, 'domain')
	};
}

function validateList(
	value: unknown,
	field: string,
	kind: 'address' | 'domain'
): SenderRuleValidationResult<string[]> {
	if (!Array.isArray(value)) return { ok: false, error: `${field} 必須是陣列` };
	if (value.length > MAX_RULES_PER_LIST) {
		return { ok: false, error: `${field} 最多只能包含 ${MAX_RULES_PER_LIST} 筆規則` };
	}

	const normalize = kind === 'address' ? normalizeEmailAddress : normalizeDomain;
	const normalized: string[] = [];
	for (const entry of value) {
		const rule = normalize(entry);
		if (!rule) {
			return {
				ok: false,
				error: `${field} 中包含無效的寄件者${kind === 'address' ? '地址' : '網域'}：${typeof entry === 'string' ? entry.trim() : '非字串值'}`
			};
		}
		normalized.push(rule);
	}

	return { ok: true, value: [...new Set(normalized)] };
}

export function validateSenderRules(value: unknown): SenderRuleValidationResult<NormalizedSenderRules> {
	if (!value || typeof value !== 'object') return { ok: false, error: '寄件者規則必須是物件' };
	const input = value as Partial<NormalizedSenderRules>;
	if (input.senderMode !== 'normal' && input.senderMode !== 'allowlist') {
		return { ok: false, error: 'senderMode 必須是 normal 或 allowlist' };
	}

	const allowedAddresses = validateList(input.allowedSenderAddresses, 'allowedSenderAddresses', 'address');
	if (!allowedAddresses.ok) return { ok: false, error: allowedAddresses.error };
	const allowedDomains = validateList(input.allowedSenderDomains, 'allowedSenderDomains', 'domain');
	if (!allowedDomains.ok) return { ok: false, error: allowedDomains.error };
	const blockedAddresses = validateList(input.blockedSenderAddresses, 'blockedSenderAddresses', 'address');
	if (!blockedAddresses.ok) return { ok: false, error: blockedAddresses.error };
	const blockedDomains = validateList(input.blockedSenderDomains, 'blockedSenderDomains', 'domain');
	if (!blockedDomains.ok) return { ok: false, error: blockedDomains.error };

	return {
		ok: true,
		value: {
			senderMode: input.senderMode,
			allowedSenderAddresses: allowedAddresses.value!,
			allowedSenderDomains: allowedDomains.value!,
			blockedSenderAddresses: blockedAddresses.value!,
			blockedSenderDomains: blockedDomains.value!
		}
	};
}

export function validateGlobalSenderBlocklist(value: unknown): SenderRuleValidationResult<GlobalSenderBlocklist> {
	if (!value || typeof value !== 'object') return { ok: false, error: '全域寄件者封鎖清單必須是物件' };
	const input = value as Partial<GlobalSenderBlocklist>;
	const addresses = validateList(input.blockedSenderAddresses, 'blockedSenderAddresses', 'address');
	if (!addresses.ok) return { ok: false, error: addresses.error };
	const domains = validateList(input.blockedSenderDomains, 'blockedSenderDomains', 'domain');
	if (!domains.ok) return { ok: false, error: domains.error };
	return {
		ok: true,
		value: {
			blockedSenderAddresses: addresses.value!,
			blockedSenderDomains: domains.value!
		}
	};
}

export function domainMatches(senderDomain: string, ruleDomain: string): boolean {
	return senderDomain === ruleDomain || senderDomain.endsWith(`.${ruleDomain}`);
}

function findMatch(
	sender: string,
	addresses: string[],
	domains: string[]
): string | null {
	if (addresses.includes(sender)) return sender;
	const senderDomain = sender.slice(sender.lastIndexOf('@') + 1);
	return domains.find((domain) => domainMatches(senderDomain, domain)) ?? null;
}

export function evaluateSenderRules(
	envelopeSender: unknown,
	alias: AliasConfig,
	globalBlocklist: GlobalSenderBlocklist
): SenderDecision {
	const sender = normalizeEmailAddress(envelopeSender);
	if (!sender) return { allowed: false, sender: null, reason: 'invalid_sender' };

	const globalRules = normalizeGlobalSenderBlocklist(globalBlocklist);
	const globalMatch = findMatch(
		sender,
		globalRules.blockedSenderAddresses,
		globalRules.blockedSenderDomains
	);
	if (globalMatch) {
		return { allowed: false, sender, reason: 'global_sender_blocked', matchedRule: globalMatch };
	}

	const aliasRules = normalizeSenderRules(alias);
	const aliasBlockMatch = findMatch(
		sender,
		aliasRules.blockedSenderAddresses,
		aliasRules.blockedSenderDomains
	);
	if (aliasBlockMatch) {
		return { allowed: false, sender, reason: 'alias_sender_blocked', matchedRule: aliasBlockMatch };
	}

	if (aliasRules.senderMode === 'allowlist') {
		const allowMatch = findMatch(
			sender,
			aliasRules.allowedSenderAddresses,
			aliasRules.allowedSenderDomains
		);
		if (!allowMatch) return { allowed: false, sender, reason: 'sender_not_in_allowlist' };
	}

	return { allowed: true, sender };
}

export function sanitizeSubject(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (!cleaned) return undefined;
	return Array.from(cleaned).slice(0, MAX_SUBJECT_LENGTH).join('');
}
