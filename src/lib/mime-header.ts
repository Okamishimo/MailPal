/**
 * Minimal RFC 2047 "encoded-word" decoding.
 *
 * Mail clients send non-ASCII header text (subjects above all) as
 * `=?UTF-8?B?...?=` or `=?ISO-2022-JP?Q?...?=`. Storing or displaying that
 * verbatim turns the activity log into mojibake, so every header value MailPal
 * keeps goes through {@link decodeMimeHeader} first.
 *
 * The decoder is deliberately forgiving: anything it cannot decode — an unknown
 * charset, malformed base64, a truncated encoded-word — is left exactly as it
 * arrived rather than replaced with garbage. Recovering text from a word that
 * was cut in half is the one exception, and it is opt-in via
 * {@link MimeDecodeOptions.recoverTruncated} because it rewrites text the
 * decoder cannot fully verify.
 */

export interface MimeDecodeOptions {
	/**
	 * Decode a trailing encoded-word that lost its closing `?=`, and drop a
	 * trailing `=?UTF-8?Q` fragment that lost its payload. Only for values a
	 * length cap is known to have truncated — activity entries stored before
	 * subjects were decoded. Off by default, so a subject that merely ends in
	 * `=?UTF-8` is left alone.
	 */
	recoverTruncated?: boolean;
}

/** Header values longer than this are truncated before decoding. */
const MAX_HEADER_LENGTH = 2000;

/** `=?charset[*lang]?B|Q?text?=` */
const ENCODED_WORD_RE = /=\?([A-Za-z0-9._:+-]+)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([^?]*)\?=/g;

/** The same, but cut off before its closing `?=` — a header truncated mid-word. */
const TRUNCATED_WORD_RE = /=\?([A-Za-z0-9._:+-]+)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([^?]*)$/;

/** `=?UTF-8?Q` and friends: a cut that took the word's payload with it. */
const DANGLING_PREFIX_RE = /\s*=\?[A-Za-z0-9._:+-]*(?:\*[A-Za-z0-9-]+)?(?:\?[BbQq]?)?$/;

function bytesFromBase64(data: string): Uint8Array | null {
	const normalized = data.replace(/\s+/g, '');
	try {
		const binary = atob(normalized);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

function bytesFromQuotedPrintable(data: string): Uint8Array | null {
	const bytes: number[] = [];
	for (let i = 0; i < data.length; i++) {
		const char = data[i];
		if (char === '_') {
			bytes.push(0x20);
			continue;
		}
		if (char === '=') {
			const hex = data.slice(i + 1, i + 3);
			if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
			continue;
		}
		const code = char.charCodeAt(0);
		if (code > 0xff) return null;
		bytes.push(code);
	}
	return new Uint8Array(bytes);
}

function latin1(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
}

function isSingleByteCharset(label: string): boolean {
	return (
		label === 'us-ascii' ||
		label === 'ascii' ||
		label.startsWith('iso-8859-') ||
		label.startsWith('windows-12')
	);
}

function tryDecode(label: string, bytes: Uint8Array, fatal: boolean): string | null {
	try {
		return new TextDecoder(label, { fatal, ignoreBOM: false }).decode(bytes);
	} catch {
		// Unknown label (constructor) or invalid bytes under `fatal` (decode).
		return null;
	}
}

/**
 * `TextDecoder` covers the WHATWG encoding labels (UTF-8, ISO-2022-JP, Shift_JIS,
 * Big5, …) in browsers, Node and workerd. Should a runtime not know a label, only
 * the single-byte charsets can be salvaged by hand; everything else gives up so
 * the caller can keep the original text.
 */
function decodeBytes(charset: string, bytes: Uint8Array): string | null {
	const label = charset.toLowerCase();

	// Senders routinely label UTF-8 headers as us-ascii or latin-1. Decoding those
	// bytes as a single-byte charset is what turns 世界 into "ä¸–ç•Œ", so when the
	// bytes are valid UTF-8 they are treated as such.
	if (isSingleByteCharset(label) && bytes.some((byte) => byte > 0x7f)) {
		const utf8 = tryDecode('utf-8', bytes, true);
		if (utf8 !== null) return utf8;
	}

	const decoded = tryDecode(label, bytes, false);
	if (decoded !== null) return decoded;
	return isSingleByteCharset(label) ? latin1(bytes) : null;
}

/** The bytes of one encoded-word's payload, or null when it is malformed. */
function wordBytes(encoding: string, data: string): Uint8Array | null {
	return encoding === 'B' || encoding === 'b'
		? bytesFromBase64(data)
		: bytesFromQuotedPrintable(data);
}

/**
 * The bytes of a trailing encoded-word that lost its closing `?=`.
 *
 * Activity entries written before subjects were decoded were capped at 200
 * characters of *encoded* text, which usually cuts the last encoded-word in
 * half. Dropping the unusable remainder — a partial base64 quantum or a dangling
 * `=X` escape — recovers the rest of the characters instead of leaving raw
 * `=?UTF-8?q?=E3=81` on screen. A genuine subject that happens to end in an
 * unterminated encoded-word is decoded too, which is the accepted trade.
 */
function truncatedWordBytes(encoding: string, data: string): Uint8Array | null {
	if (encoding === 'B' || encoding === 'b') {
		const compact = data.replace(/\s+/g, '');
		const whole = compact.slice(0, compact.length - (compact.length % 4));
		return whole ? bytesFromBase64(whole) : null;
	}
	const whole = data.replace(/=[0-9A-Fa-f]?$/, '');
	return whole ? bytesFromQuotedPrintable(whole) : null;
}

interface EncodedWord {
	start: number;
	end: number;
	charset: string;
	encoding: string;
	bytes: Uint8Array | null;
	truncated: boolean;
}

function collectWords(input: string, recoverTruncated: boolean): EncodedWord[] {
	const words: EncodedWord[] = [];

	ENCODED_WORD_RE.lastIndex = 0;
	for (let match = ENCODED_WORD_RE.exec(input); match; match = ENCODED_WORD_RE.exec(input)) {
		words.push({
			start: match.index,
			end: match.index + match[0].length,
			charset: match[1],
			encoding: match[2],
			bytes: wordBytes(match[2], match[3]),
			truncated: false
		});
	}

	if (!recoverTruncated) return words;

	const consumed = words.length > 0 ? words[words.length - 1].end : 0;
	const tail = input.slice(consumed);
	const cut = TRUNCATED_WORD_RE.exec(tail);
	if (cut) {
		words.push({
			start: consumed + cut.index,
			end: input.length,
			charset: cut[1],
			encoding: cut[2],
			bytes: truncatedWordBytes(cut[2], cut[3]),
			truncated: true
		});
	}

	return words;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

/** One encoded-word's text, or null when it cannot be decoded on its own. */
function decodeWord(word: EncodedWord): string | null {
	if (word.bytes === null) return null;
	const decoded = decodeBytes(word.charset, word.bytes);
	if (decoded === null) return null;
	// A truncated word's cut can land inside a character; anything else replaced
	// means the charset was wrong, and the raw text is the better thing to show.
	const cleaned = word.truncated ? decoded.replace(/\uFFFD+$/, '') : decoded;
	return cleaned && !cleaned.includes('\uFFFD') ? cleaned : null;
}

/**
 * Decodes a run as one byte stream, rescuing senders that split a multi-byte
 * character across the fold in violation of RFC 2047 §5.
 *
 * This runs only after word-by-word decoding fails, because joining is wrong for
 * the stateful ISO-2022-* charsets: word one ends with an escape back to ASCII
 * and word two opens with another escape, and two escape sequences in a row are
 * an error that decodes to U+FFFD.
 */
function decodeJoined(run: EncodedWord[]): string | null {
	const chunks: Uint8Array[] = [];
	for (const word of run) {
		if (word.bytes === null) return null;
		chunks.push(word.bytes);
	}

	const decoded = decodeBytes(run[0].charset, concatBytes(chunks));
	if (decoded === null) return null;
	const cleaned = run[run.length - 1].truncated ? decoded.replace(/\uFFFD+$/, '') : decoded;
	return cleaned && !cleaned.includes('\uFFFD') ? cleaned : null;
}

/**
 * Keeps the words that did decode and shows only the broken ones raw, so one
 * malformed encoded-word cannot hide the readable text beside it.
 */
function decodePartially(run: EncodedWord[], parts: (string | null)[], input: string): string {
	let decodedRun = '';
	for (let index = 0; index < run.length; index++) {
		if (index > 0) {
			// RFC 2047 §6.2 drops the whitespace between two decoded words; it stays
			// when either side is shown raw, so the fragment reads as its own token.
			const gap = input.slice(run[index - 1].end, run[index].start);
			if (parts[index - 1] === null || parts[index] === null) decodedRun += gap;
		}
		decodedRun += parts[index] ?? input.slice(run[index].start, run[index].end);
	}
	return decodedRun;
}

function decodeRun(run: EncodedWord[], input: string): string | null {
	const parts = run.map(decodeWord);
	if (parts.every((part) => part !== null)) return parts.join('');

	const joined = decodeJoined(run);
	if (joined !== null) return joined;

	if (parts.every((part) => part === null)) return null;
	return decodePartially(run, parts, input);
}

function joinsPrevious(input: string, previous: EncodedWord, next: EncodedWord): boolean {
	return (
		previous.bytes !== null &&
		next.bytes !== null &&
		previous.charset.toLowerCase() === next.charset.toLowerCase() &&
		previous.encoding.toUpperCase() === next.encoding.toUpperCase() &&
		input.slice(previous.end, next.start).trim() === ''
	);
}

/**
 * Decodes every RFC 2047 encoded-word in a header value, leaving surrounding
 * plain text untouched. Whitespace that only separates two adjacent encoded
 * words is dropped, as RFC 2047 §6.2 requires — that is how a long subject split
 * across several encoded-words joins back up without stray spaces.
 */
export function decodeMimeHeader(
	value: string | null | undefined,
	{ recoverTruncated = false }: MimeDecodeOptions = {}
): string {
	if (typeof value !== 'string' || !value) return '';
	const overlong = value.length > MAX_HEADER_LENGTH;
	const input = overlong ? value.slice(0, MAX_HEADER_LENGTH) : value;
	if (!input.includes('=?')) return input;

	// Recovery is guesswork about text that is already gone, so it is opt-in —
	// except when this call is the one that did the cutting.
	const recover = recoverTruncated || overlong;
	const words = collectWords(input, recover);
	if (words.length === 0) return recover ? input.replace(DANGLING_PREFIX_RE, '') : input;

	let decodedValue = '';
	let cursor = 0;
	let previousRunDecoded = false;

	for (let index = 0; index < words.length; ) {
		let last = index;
		while (last + 1 < words.length && joinsPrevious(input, words[last], words[last + 1])) last++;

		const run = words.slice(index, last + 1);
		const gap = input.slice(cursor, run[0].start);
		const decoded = decodeRun(run, input);
		if (decoded === null) {
			decodedValue += gap + input.slice(run[0].start, run[run.length - 1].end);
			previousRunDecoded = false;
		} else {
			decodedValue += previousRunDecoded && gap.trim() === '' ? '' : gap;
			decodedValue += decoded;
			previousRunDecoded = true;
		}

		cursor = run[run.length - 1].end;
		index = last + 1;
	}

	const tail = input.slice(cursor);
	return decodedValue + (recover ? tail.replace(DANGLING_PREFIX_RE, '') : tail);
}
