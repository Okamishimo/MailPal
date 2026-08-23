import type { KVNamespace } from '@cloudflare/workers-types';
import type {
	AliasConfig,
	BackupEntry,
	BackupImportMode,
	DomainConfig,
	LogEntry,
	MailPalBackup,
	Tag
} from '../types.js';
import {
	MAX_RULES_PER_LIST,
	normalizeDomain,
	normalizeEmailAddress,
	validateGlobalSenderBlocklist
} from '../sender-rules.js';

export const BACKUP_FORMAT = 'mailpal-backup' as const;
export const BACKUP_VERSION = 1 as const;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 450;

const MANAGED_PREFIXES = ['domain:', 'alias:', 'destination:', 'tag:', 'log:'] as const;
const MANAGED_SETTINGS_KEYS = ['settings:onboarded', 'settings:sender-blocklist'] as const;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;
const BLOCK_REASONS = new Set([
	'alias_disabled',
	'global_sender_blocked',
	'alias_sender_blocked',
	'sender_not_in_allowlist',
	'alias_expired',
	'forwarding_limit_reached',
	'invalid_sender'
]);

interface ValidationSuccess {
	ok: true;
	backup: MailPalBackup;
}

interface ValidationFailure {
	ok: false;
	error: string;
}

export type BackupValidationResult = ValidationSuccess | ValidationFailure;

export interface RestoreSummary {
	mode: BackupImportMode;
	imported: number;
	removed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function parseJson(value: string, label: string): { ok: true; value: unknown } | ValidationFailure {
	try {
		return { ok: true, value: JSON.parse(value) as unknown };
	} catch {
		return { ok: false, error: `${label} 的內容不是有效 JSON` };
	}
}

function splitEntityKey(key: string, prefix: string): string | null {
	if (!key.startsWith(prefix)) return null;
	const suffix = key.slice(prefix.length);
	return suffix.length > 0 ? suffix : null;
}

function validateDomainEntry(key: string, value: string): string | null {
	const keyDomain = splitEntityKey(key, 'domain:');
	if (!keyDomain || normalizeDomain(keyDomain) !== keyDomain) return '網域鍵值無效';
	const parsed = parseJson(value, key);
	if (!parsed.ok) return parsed.error;
	if (!isRecord(parsed.value)) return `${key} 必須是物件`;

	const domain = parsed.value as Partial<DomainConfig>;
	if (
		domain.domain !== keyDomain ||
		typeof domain.targetEmail !== 'string' ||
		!normalizeEmailAddress(domain.targetEmail) ||
		!isBoolean(domain.wildcardEnabled) ||
		!isBoolean(domain.enabled) ||
		!isFiniteNumber(domain.createdAt) ||
		(domain.color !== undefined && (typeof domain.color !== 'string' || !HEX_COLOR_RE.test(domain.color)))
	) {
		return `${key} 的網域設定無效`;
	}
	return null;
}

function validateAliasEntry(key: string, value: string): string | null {
	const suffix = splitEntityKey(key, 'alias:');
	if (!suffix) return '別名鍵值無效';
	const slash = suffix.indexOf('/');
	if (slash <= 0 || slash !== suffix.lastIndexOf('/')) return '別名鍵值無效';
	const keyDomain = suffix.slice(0, slash);
	const keyLocalPart = suffix.slice(slash + 1);
	if (normalizeDomain(keyDomain) !== keyDomain || !LOCAL_PART_RE.test(keyLocalPart) || keyLocalPart.length > 64) {
		return '別名鍵值無效';
	}

	const parsed = parseJson(value, key);
	if (!parsed.ok) return parsed.error;
	if (!isRecord(parsed.value)) return `${key} 必須是物件`;
	const alias = parsed.value as Partial<AliasConfig>;
	if (
		alias.domain !== keyDomain ||
		alias.localPart !== keyLocalPart ||
		(alias.targetEmail !== null && (typeof alias.targetEmail !== 'string' || !normalizeEmailAddress(alias.targetEmail))) ||
		!isBoolean(alias.enabled) ||
		!isFiniteNumber(alias.createdAt) ||
		!Number.isInteger(alias.forwardedCount) ||
		(alias.forwardedCount ?? -1) < 0 ||
		!Number.isInteger(alias.blockedCount) ||
		(alias.blockedCount ?? -1) < 0 ||
		(alias.lastUsedAt !== null && !isFiniteNumber(alias.lastUsedAt)) ||
		!isBoolean(alias.autoCreated) ||
		!isOptionalString(alias.note) ||
		!isOptionalStringArray(alias.tags) ||
		(alias.senderMode !== undefined && alias.senderMode !== 'normal' && alias.senderMode !== 'allowlist') ||
		!isOptionalStringArray(alias.allowedSenderAddresses) ||
		!isOptionalStringArray(alias.allowedSenderDomains) ||
		!isOptionalStringArray(alias.blockedSenderAddresses) ||
		!isOptionalStringArray(alias.blockedSenderDomains) ||
		(alias.expiresAt !== undefined && !isFiniteNumber(alias.expiresAt)) ||
		(alias.maxForwards !== undefined && (!Number.isInteger(alias.maxForwards) || (alias.maxForwards ?? 0) < 1))
	) {
		return `${key} 的別名設定無效`;
	}

	const ruleLists = [
		alias.allowedSenderAddresses,
		alias.allowedSenderDomains,
		alias.blockedSenderAddresses,
		alias.blockedSenderDomains
	];
	if (ruleLists.some((list) => (list?.length ?? 0) > MAX_RULES_PER_LIST)) {
		return `${key} 的寄件者規則數量超過上限`;
	}
	return null;
}

function validateDestinationEntry(key: string, value: string): string | null {
	const keyEmail = splitEntityKey(key, 'destination:');
	if (!keyEmail || !normalizeEmailAddress(keyEmail)) return '轉寄地址鍵值無效';
	const parsed = parseJson(value, key);
	if (!parsed.ok) return parsed.error;
	if (!isRecord(parsed.value)) return `${key} 必須是物件`;
	if (parsed.value.email !== keyEmail || !isFiniteNumber(parsed.value.createdAt)) {
		return `${key} 的轉寄地址設定無效`;
	}
	return null;
}

function validateTagEntry(key: string, value: string): string | null {
	const keyName = splitEntityKey(key, 'tag:');
	if (!keyName || keyName.length > 50) return '標籤鍵值無效';
	const parsed = parseJson(value, key);
	if (!parsed.ok) return parsed.error;
	if (!isRecord(parsed.value)) return `${key} 必須是物件`;
	const tag = parsed.value as Partial<Tag>;
	if (
		tag.name !== keyName ||
		typeof tag.color !== 'string' ||
		!HEX_COLOR_RE.test(tag.color) ||
		!isFiniteNumber(tag.createdAt)
	) {
		return `${key} 的標籤設定無效`;
	}
	return null;
}

function validateLogEntry(key: string, value: string): string | null {
	const suffix = splitEntityKey(key, 'log:');
	if (!suffix) return '活動紀錄鍵值無效';
	const slash = suffix.indexOf('/');
	if (slash <= 0 || slash !== suffix.lastIndexOf('/')) return '活動紀錄鍵值無效';
	const domain = suffix.slice(0, slash);
	const localPart = suffix.slice(slash + 1);
	if (normalizeDomain(domain) !== domain || !LOCAL_PART_RE.test(localPart)) return '活動紀錄鍵值無效';

	const parsed = parseJson(value, key);
	if (!parsed.ok) return parsed.error;
	if (!Array.isArray(parsed.value)) return `${key} 必須是陣列`;
	if (parsed.value.length > 1000) return `${key} 的活動紀錄數量過多`;

	for (const item of parsed.value) {
		if (!isRecord(item)) return `${key} 包含無效的活動紀錄`;
		const log = item as Partial<LogEntry>;
		if (
			!isFiniteNumber(log.at) ||
			(log.action !== 'forwarded' && log.action !== 'blocked') ||
			typeof log.from !== 'string' ||
			typeof log.to !== 'string' ||
			!isOptionalString(log.recipient) ||
			(log.reason !== undefined && (typeof log.reason !== 'string' || !BLOCK_REASONS.has(log.reason))) ||
			!isOptionalString(log.matchedRule) ||
			!isOptionalString(log.subject)
		) {
			return `${key} 包含無效的活動紀錄`;
		}
	}
	return null;
}

function validateSettingsEntry(key: string, value: string): string | null {
	if (key === 'settings:onboarded') {
		return value === '1' ? null : 'onboarding 狀態無效';
	}
	if (key === 'settings:sender-blocklist') {
		const parsed = parseJson(value, key);
		if (!parsed.ok) return parsed.error;
		const result = validateGlobalSenderBlocklist(parsed.value);
		return result.ok ? null : (result.error ?? '全域寄件者封鎖清單無效');
	}
	return '備份包含不支援的設定鍵值';
}

function validateEntry(entry: BackupEntry): string | null {
	if (entry.key.length === 0 || entry.key.length > 512) return '備份包含無效的鍵值';
	if (entry.key.startsWith('domain:')) return validateDomainEntry(entry.key, entry.value);
	if (entry.key.startsWith('alias:')) return validateAliasEntry(entry.key, entry.value);
	if (entry.key.startsWith('destination:')) return validateDestinationEntry(entry.key, entry.value);
	if (entry.key.startsWith('tag:')) return validateTagEntry(entry.key, entry.value);
	if (entry.key.startsWith('log:')) return validateLogEntry(entry.key, entry.value);
	return validateSettingsEntry(entry.key, entry.value);
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function checksumEntries(entries: BackupEntry[]): Promise<string> {
	return `sha256:${await sha256(JSON.stringify(entries))}`;
}

async function listPrefixKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
		names.push(...page.keys.map((key) => key.name));
		if (page.list_complete !== false || !page.cursor) break;
		cursor = page.cursor;
	} while (cursor);
	return names;
}

export async function listManagedKeys(kv: KVNamespace): Promise<string[]> {
	const prefixGroups = await Promise.all(MANAGED_PREFIXES.map((prefix) => listPrefixKeys(kv, prefix)));
	const names = new Set(prefixGroups.flat());
	const settings = await Promise.all(
		MANAGED_SETTINGS_KEYS.map(async (key) => ({ key, value: await kv.get(key) }))
	);
	for (const setting of settings) {
		if (setting.value !== null) names.add(setting.key);
	}
	return [...names].sort();
}

async function readEntries(kv: KVNamespace, keys: string[]): Promise<BackupEntry[]> {
	const entries: BackupEntry[] = [];
	for (let index = 0; index < keys.length; index += 50) {
		const batch = keys.slice(index, index + 50);
		const values = await Promise.all(batch.map((key) => kv.get(key)));
		for (let itemIndex = 0; itemIndex < batch.length; itemIndex++) {
			const value = values[itemIndex];
			if (value !== null) entries.push({ key: batch[itemIndex], value });
		}
	}
	return entries;
}

export async function createBackup(kv: KVNamespace): Promise<MailPalBackup> {
	const keys = await listManagedKeys(kv);
	if (keys.length > MAX_BACKUP_ENTRIES) {
		throw new Error(`資料筆數超過單次備份上限（${MAX_BACKUP_ENTRIES} 筆）`);
	}
	const entries = await readEntries(kv, keys);
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		checksum: await checksumEntries(entries),
		entries
	};
}

export async function validateBackup(input: unknown): Promise<BackupValidationResult> {
	if (!isRecord(input)) return { ok: false, error: '備份檔案必須是 JSON 物件' };
	if (input.format !== BACKUP_FORMAT) return { ok: false, error: '這不是 MailPal 備份檔案' };
	if (input.version !== BACKUP_VERSION) return { ok: false, error: '不支援此備份版本' };
	if (typeof input.exportedAt !== 'string' || !Number.isFinite(Date.parse(input.exportedAt))) {
		return { ok: false, error: '備份時間無效' };
	}
	if (typeof input.checksum !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.checksum)) {
		return { ok: false, error: '備份校驗碼無效' };
	}
	if (!Array.isArray(input.entries)) return { ok: false, error: '備份資料格式無效' };
	if (input.entries.length > MAX_BACKUP_ENTRIES) {
		return { ok: false, error: `備份最多只能包含 ${MAX_BACKUP_ENTRIES} 筆資料` };
	}

	const entries: BackupEntry[] = [];
	const keys = new Set<string>();
	for (const rawEntry of input.entries) {
		if (!isRecord(rawEntry) || typeof rawEntry.key !== 'string' || typeof rawEntry.value !== 'string') {
			return { ok: false, error: '備份包含無效的資料項目' };
		}
		if (keys.has(rawEntry.key)) return { ok: false, error: `備份包含重複鍵值：${rawEntry.key}` };
		keys.add(rawEntry.key);
		const entry = { key: rawEntry.key, value: rawEntry.value };
		const entryError = validateEntry(entry);
		if (entryError) return { ok: false, error: entryError };
		entries.push(entry);
	}

	const expectedChecksum = await checksumEntries(entries);
	if (expectedChecksum !== input.checksum) {
		return { ok: false, error: '備份校驗失敗，檔案可能已損毀或被修改' };
	}

	return {
		ok: true,
		backup: {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exportedAt: input.exportedAt,
			checksum: input.checksum,
			entries
		}
	};
}

async function runInBatches<T>(items: T[], operation: (item: T) => Promise<void>): Promise<void> {
	for (let index = 0; index < items.length; index += 25) {
		await Promise.all(items.slice(index, index + 25).map(operation));
	}
}

export async function restoreBackup(
	kv: KVNamespace,
	backup: MailPalBackup,
	mode: BackupImportMode
): Promise<RestoreSummary> {
	const currentKeys = mode === 'replace' ? await listManagedKeys(kv) : [];
	await runInBatches(backup.entries, (entry) => kv.put(entry.key, entry.value));

	const importedKeys = new Set(backup.entries.map((entry) => entry.key));
	const staleKeys = mode === 'replace'
		? currentKeys.filter((key) => !importedKeys.has(key))
		: [];
	await runInBatches(staleKeys, (key) => kv.delete(key));

	return { mode, imported: backup.entries.length, removed: staleKeys.length };
}
