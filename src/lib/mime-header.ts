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
 * arrived rather than replaced with garbage.
 */

/** Header values longer than this are truncated before decoding. */
const MAX_HEADER_LENGTH = 2000;

/** `=?charset[*lang]?B|Q?text?=` */
const ENCODED_WORD_RE = /=\?([A-Za-z0-9._:+-]+)(?:\*[A-Za-z0-9-]+)?\?([BbQq])\?([^?]*)\?=/g;

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

function decodeEncodedWord(charset: string, encoding: string, data: string): string | null {
	const bytes =
		encoding === 'B' || encoding === 'b' ? bytesFromBase64(data) : bytesFromQuotedPrintable(data);
	if (!bytes) return null;
	const decoded = decodeBytes(charset, bytes);
	// A charset mismatch shows up as replacement characters; keep the original instead.
	if (decoded === null || decoded.includes('�')) return null;
	return decoded;
}

/**
 * Decodes every RFC 2047 encoded-word in a header value, leaving surrounding
 * plain text untouched. Whitespace that only separates two adjacent encoded
 * words is dropped, as RFC 2047 §6.2 requires — that is how a long subject split
 * across several encoded-words joins back up without stray spaces.
 */
export function decodeMimeHeader(value: string | null | undefined): string {
	if (!value) return '';
	const input = value.length > MAX_HEADER_LENGTH ? value.slice(0, MAX_HEADER_LENGTH) : value;
	if (!input.includes('=?')) return input;

	let decodedValue = '';
	let cursor = 0;
	let previousWasEncoded = false;

	ENCODED_WORD_RE.lastIndex = 0;
	for (let match = ENCODED_WORD_RE.exec(input); match; match = ENCODED_WORD_RE.exec(input)) {
		const gap = input.slice(cursor, match.index);
		const decodedWord = decodeEncodedWord(match[1], match[2], match[3]);
		if (decodedWord === null) {
			decodedValue += gap + match[0];
			previousWasEncoded = false;
		} else {
			decodedValue += previousWasEncoded && gap.trim() === '' ? '' : gap;
			decodedValue += decodedWord;
			previousWasEncoded = true;
		}
		cursor = match.index + match[0].length;
	}

	return decodedValue + input.slice(cursor);
}
