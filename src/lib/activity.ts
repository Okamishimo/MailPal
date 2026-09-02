import type { LogEntry } from './types.js';
import { sanitizeSubject } from './sender-rules.js';

/**
 * The activity log lives in D1 rather than KV. A KV log was a ring buffer that
 * had to be read, unshifted and written back on every message — two KV writes
 * per delivery against a free-plan budget of 1,000 a day. An insert is a single
 * append with no prior read, and D1's free plan allows 100,000 row writes a day.
 *
 * This module holds the parts both the email worker and the dashboard need, so
 * the row shape stays defined in exactly one place.
 */

export const ACTIVITY_INSERT_SQL =
	`INSERT INTO activity
		(domain, local_part, at, action, from_addr, to_addr, reason, matched_rule, subject, header_from, cc)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** One `activity` row as D1 returns it. */
export interface ActivityRow {
	domain: string;
	local_part: string;
	at: number;
	action: string;
	from_addr: string;
	to_addr: string;
	reason: string | null;
	matched_rule: string | null;
	subject: string | null;
	header_from: string | null;
	cc: string | null;
}

/** Positional bindings for {@link ACTIVITY_INSERT_SQL}, in column order. */
export function activityInsertBindings(
	domain: string,
	localPart: string,
	entry: LogEntry
): (string | number | null)[] {
	return [
		domain,
		localPart,
		entry.at,
		entry.action,
		entry.from,
		entry.to,
		entry.reason ?? null,
		entry.matchedRule ?? null,
		entry.subject ?? null,
		entry.headerFrom ?? null,
		entry.cc && entry.cc.length > 0 ? JSON.stringify(entry.cc) : null
	];
}

function parseCc(value: string | null): string[] | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return undefined;
		const addresses = parsed.filter((item): item is string => typeof item === 'string');
		return addresses.length > 0 ? addresses : undefined;
	} catch {
		// Match the KV readers: one malformed field must not break a whole page.
		return undefined;
	}
}

/**
 * Rebuild a {@link LogEntry} from a row. `recipient` is derived rather than
 * stored, and subjects are re-decoded because rows imported from a pre-D1
 * backup can still hold RFC 2047 encoded-words.
 */
export function rowToLogEntry(row: ActivityRow): LogEntry {
	const subject =
		typeof row.subject === 'string'
			? sanitizeSubject(row.subject, { recoverTruncated: true })
			: undefined;
	const cc = parseCc(row.cc);
	return {
		at: row.at,
		action: row.action === 'blocked' ? 'blocked' : 'forwarded',
		from: row.from_addr,
		to: row.to_addr,
		recipient: `${row.local_part}@${row.domain}`,
		...(row.reason ? { reason: row.reason as LogEntry['reason'] } : {}),
		...(row.matched_rule ? { matchedRule: row.matched_rule } : {}),
		...(subject ? { subject } : {}),
		...(row.header_from ? { headerFrom: row.header_from } : {}),
		...(cc ? { cc } : {})
	};
}
