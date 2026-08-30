import type {
	KVNamespace,
	ForwardableEmailMessage,
	ExecutionContext
} from '@cloudflare/workers-types';
import type {
	AliasConfig,
	BlockReason,
	DomainConfig,
	GlobalSenderBlocklist,
	LogEntry
} from '../../src/lib/types.js';
import {
	evaluateSenderRules,
	extractHeaderAddresses,
	MAX_CC_ADDRESSES,
	normalizeEmailAddress,
	normalizeGlobalSenderBlocklist,
	sanitizeSubject
} from '../../src/lib/sender-rules.js';

const LOG_LIMIT = 50;
const GENERIC_REJECTION = 'Message rejected';

/**
 * The bounded, display-only header metadata an activity entry keeps: a decoded
 * subject plus the `From:`/`Cc:` addresses. `From:` is stored only when it
 * differs from the envelope sender, which is what the bounce/SRS addresses in
 * forwarded newsletters look like; authorization still uses the envelope alone.
 */
function activityMetadata(
	message: ForwardableEmailMessage,
	envelopeSender: string | null
): Pick<LogEntry, 'subject' | 'headerFrom' | 'cc'> {
	const subject = sanitizeSubject(message.headers.get('subject'));
	const headerFrom = extractHeaderAddresses(message.headers.get('from'), 1)[0];
	const cc = extractHeaderAddresses(message.headers.get('cc'), MAX_CC_ADDRESSES);
	return {
		...(subject ? { subject } : {}),
		...(headerFrom && headerFrom !== envelopeSender ? { headerFrom } : {}),
		...(cc.length > 0 ? { cc } : {})
	};
}

function schedule(ctx: ExecutionContext, promise: Promise<unknown>, operation: string): void {
	ctx.waitUntil(
		promise.catch((error) => {
			console.error(JSON.stringify({
				message: 'Background email operation failed',
				operation,
				error: error instanceof Error ? error.message : String(error)
			}));
		})
	);
}

export async function appendLog(
	kv: KVNamespace,
	domain: string,
	localPart: string,
	entry: LogEntry
): Promise<void> {
	const key = `log:${domain}/${localPart}`;
	let log: LogEntry[] = [];
	try {
		const existing = await kv.get(key);
		const parsed: unknown = existing ? JSON.parse(existing) : [];
		if (Array.isArray(parsed)) log = parsed as LogEntry[];
	} catch {
		// A malformed historical log should not interrupt mail delivery.
	}
	log.unshift(entry);
	if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
	await kv.put(key, JSON.stringify(log));
}

async function getGlobalSenderBlocklist(kv: KVNamespace): Promise<GlobalSenderBlocklist> {
	const value = await kv.get('settings:sender-blocklist');
	if (!value) return normalizeGlobalSenderBlocklist(null);
	try {
		return normalizeGlobalSenderBlocklist(JSON.parse(value));
	} catch {
		console.error(JSON.stringify({ message: 'Ignoring malformed global sender blocklist' }));
		return normalizeGlobalSenderBlocklist(null);
	}
}

interface BlockMessageOptions {
	reason: BlockReason;
	sender: string | null;
	matchedRule?: string;
	disableAlias?: boolean;
}

function blockMessage(
	message: ForwardableEmailMessage,
	env: Env,
	ctx: ExecutionContext,
	domain: string,
	localPart: string,
	aliasConfig: AliasConfig,
	domainConfig: DomainConfig,
	options: BlockMessageOptions
): void {
	const now = Date.now();
	const target = aliasConfig.targetEmail ?? domainConfig.targetEmail;
	const updated: AliasConfig = {
		...aliasConfig,
		...(options.disableAlias ? { enabled: false } : {}),
		blockedCount: (aliasConfig.blockedCount ?? 0) + 1,
		lastUsedAt: now
	};
	const entry: LogEntry = {
		at: now,
		action: 'blocked',
		from: options.sender ?? '',
		to: target,
		recipient: `${localPart}@${domain}`,
		reason: options.reason,
		...(options.matchedRule ? { matchedRule: options.matchedRule } : {}),
		...activityMetadata(message, options.sender)
	};

	schedule(
		ctx,
		Promise.all([
			env.KV.put(`alias:${domain}/${localPart}`, JSON.stringify(updated)),
			appendLog(env.KV, domain, localPart, entry)
		]),
		`record_${options.reason}`
	);
	console.log(JSON.stringify({
		message: 'Email blocked',
		recipient: entry.recipient,
		reason: options.reason
	}));
	message.setReject(GENERIC_REJECTION);
}

export async function handleEmail(
	message: ForwardableEmailMessage,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	const to = message.to;
	const atIdx = to.indexOf('@');

	if (atIdx <= 0 || atIdx !== to.lastIndexOf('@') || atIdx === to.length - 1) {
		console.log(JSON.stringify({ message: 'Invalid envelope recipient' }));
		message.setReject('Address unavailable');
		return;
	}

	const localPart = to.slice(0, atIdx).trim().toLowerCase();
	const domain = to.slice(atIdx + 1).trim().toLowerCase();

	try {
		// 1. Resolve the configured domain and alias, including wildcard creation.
		const domainVal = await env.KV.get(`domain:${domain}`);
		if (!domainVal) {
			console.log(JSON.stringify({ message: 'Unknown recipient domain', domain }));
			message.setReject('Address unavailable');
			return;
		}

		const domainConfig = JSON.parse(domainVal) as DomainConfig;
		if (!domainConfig.enabled) {
			console.log(JSON.stringify({ message: 'Recipient domain disabled', domain }));
			message.setReject('Address unavailable');
			return;
		}

		const aliasKey = `alias:${domain}/${localPart}`;
		const aliasVal = await env.KV.get(aliasKey);
		let aliasConfig: AliasConfig | null = aliasVal ? JSON.parse(aliasVal) as AliasConfig : null;

		if (!aliasConfig && domainConfig.wildcardEnabled) {
			aliasConfig = {
				localPart,
				domain,
				targetEmail: null,
				enabled: true,
				createdAt: Date.now(),
				forwardedCount: 0,
				blockedCount: 0,
				lastUsedAt: null,
				autoCreated: true
			};
		}

		if (!aliasConfig) {
			console.log(JSON.stringify({ message: 'Unknown recipient alias', domain, localPart }));
			message.setReject('Address unavailable');
			return;
		}

		// 2. Existing enabled/disabled behavior remains the authoritative disabled mode.
		if (!aliasConfig.enabled) {
			blockMessage(message, env, ctx, domain, localPart, aliasConfig, domainConfig, {
				reason: 'alias_disabled',
				sender: normalizeEmailAddress(message.from)
			});
			return;
		}

		// 3-5. Global blocks, alias blocks, then allowlist authorization.
		const globalBlocklist = await getGlobalSenderBlocklist(env.KV);
		const senderDecision = evaluateSenderRules(message.from, aliasConfig, globalBlocklist);
		if (!senderDecision.allowed) {
			blockMessage(message, env, ctx, domain, localPart, aliasConfig, domainConfig, {
				reason: senderDecision.reason!,
				sender: senderDecision.sender,
				matchedRule: senderDecision.matchedRule
			});
			return;
		}

		// 6. Preserve expiry and forwarding-limit checks after sender authorization.
		if (aliasConfig.expiresAt && Date.now() > aliasConfig.expiresAt) {
			blockMessage(message, env, ctx, domain, localPart, aliasConfig, domainConfig, {
				reason: 'alias_expired',
				sender: senderDecision.sender,
				disableAlias: true
			});
			return;
		}

		if (
			aliasConfig.maxForwards != null &&
			(aliasConfig.forwardedCount ?? 0) >= aliasConfig.maxForwards
		) {
			blockMessage(message, env, ctx, domain, localPart, aliasConfig, domainConfig, {
				reason: 'forwarding_limit_reached',
				sender: senderDecision.sender,
				disableAlias: true
			});
			return;
		}

		// 7. Forward allowed mail, then record only bounded metadata.
		const target = aliasConfig.targetEmail ?? domainConfig.targetEmail;
		await message.forward(target);

		const now = Date.now();
		const updated: AliasConfig = {
			...aliasConfig,
			forwardedCount: (aliasConfig.forwardedCount ?? 0) + 1,
			lastUsedAt: now
		};
		const entry: LogEntry = {
			at: now,
			action: 'forwarded',
			from: senderDecision.sender!,
			to: target,
			recipient: `${localPart}@${domain}`,
			...activityMetadata(message, senderDecision.sender)
		};
		schedule(
			ctx,
			Promise.all([
				env.KV.put(aliasKey, JSON.stringify(updated)),
				appendLog(env.KV, domain, localPart, entry)
			]),
			'record_forwarded'
		);
		console.log(JSON.stringify({ message: 'Email forwarded', recipient: entry.recipient }));
	} catch (error) {
		console.error(JSON.stringify({
			message: 'Error processing email',
			recipient: to,
			error: error instanceof Error ? error.message : String(error)
		}));
		message.setReject('Internal error');
	}
}

/**
 * This Worker only handles inbound email — it deliberately exposes no HTTP API.
 * Every HTTP request gets a bare 404 so that, even if the workers.dev URL is
 * left enabled, nobody can read data or probe behavior over HTTP.
 */
export async function handleFetch(): Promise<Response> {
	return new Response(null, { status: 404 });
}

export default {
	email: handleEmail,
	fetch: handleFetch
} satisfies ExportedHandler<Env>;
