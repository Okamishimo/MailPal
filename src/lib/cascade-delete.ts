/**
 * Client half of the bounded cascade-delete protocol: the server clears one
 * page of dependent records per request and answers 202 while more remain, so
 * the browser has to keep asking until it gets a terminal status.
 */

/** Round trips one cascade may take before handing control back to the user. */
export const MAX_CASCADE_REQUESTS = 40;
// Each 202 means the server just wrote its progress marker, and KV rejects a
// second write to the same key inside one second with a 429. Retrying faster
// than that would only turn the next page into an error.
const RETRY_DELAY_MS = 1_100;

export type CascadeDeleteResult = { ok: true } | { ok: false; error: string };

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError(signal));
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortError(signal!));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Drive a cascading DELETE to completion. Retries are capped and spaced at least
 * a second apart, so a server that keeps answering 202 — for instance because an
 * eventually consistent read makes it restart the same page — can neither spin
 * the browser nor trip KV's one-write-per-second-per-key limit. Progress is
 * durable on the server, so giving up just means the user retries.
 */
export async function pollCascadeDelete(
	url: string,
	{ signal, failureMessage }: { signal?: AbortSignal; failureMessage: string }
): Promise<CascadeDeleteResult> {
	for (let attempt = 0; attempt < MAX_CASCADE_REQUESTS; attempt++) {
		const res = await fetch(url, { method: 'DELETE', signal });
		// 404 means the record is already gone — the delete got what it wanted.
		if (res.status === 204 || res.status === 404) return { ok: true };
		if (res.status !== 202) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			return { ok: false, error: body.error ?? failureMessage };
		}
		// No point pausing after the final attempt — we are about to give up.
		if (attempt < MAX_CASCADE_REQUESTS - 1) await delay(RETRY_DELAY_MS, signal);
	}
	return { ok: false, error: '資料量較多，尚未清理完成，請再刪除一次以繼續。' };
}
