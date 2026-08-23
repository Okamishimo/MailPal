export interface DomainConfig {
	domain: string;
	targetEmail: string;
	wildcardEnabled: boolean;
	enabled: boolean;
	createdAt: number;
	color?: string;
}

export interface DestinationAddress {
	email: string;
	createdAt: number;
}

export interface Tag {
	name: string;
	color: string; // hex, e.g. "#3b82f6"
	createdAt: number;
}

export type SenderMode = 'normal' | 'allowlist';

export interface SenderRuleFields {
	senderMode?: SenderMode;
	allowedSenderAddresses?: string[];
	allowedSenderDomains?: string[];
	blockedSenderAddresses?: string[];
	blockedSenderDomains?: string[];
}

export interface GlobalSenderBlocklist {
	blockedSenderAddresses: string[];
	blockedSenderDomains: string[];
}

export type BlockReason =
	| 'alias_disabled'
	| 'global_sender_blocked'
	| 'alias_sender_blocked'
	| 'sender_not_in_allowlist'
	| 'alias_expired'
	| 'forwarding_limit_reached'
	| 'invalid_sender';

export interface LogEntry {
	at: number;             // Unix ms
	action: 'forwarded' | 'blocked';
	from: string;           // sender address
	to: string;             // destination / would-be destination
	recipient?: string;     // alias address that received the message
	reason?: BlockReason;
	matchedRule?: string;
	subject?: string;
}

export interface AliasConfig extends SenderRuleFields {
	localPart: string;
	domain: string;
	targetEmail: string | null; // null = inherit from domain
	enabled: boolean;
	createdAt: number;
	forwardedCount: number;
	blockedCount: number;
	lastUsedAt: number | null;
	autoCreated: boolean;
	note?: string;
	tags?: string[];
	expiresAt?: number;    // Unix ms — worker rejects after this timestamp
	maxForwards?: number;  // worker auto-disables when forwardedCount >= this
}

export interface BackupEntry {
	key: string;
	value: string;
}

export interface MailPalBackup {
	format: 'mailpal-backup';
	version: 1;
	exportedAt: string;
	checksum: string;
	entries: BackupEntry[];
}

export type BackupImportMode = 'merge' | 'replace';
