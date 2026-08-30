import { describe, expect, it } from 'vitest';
import { decodeMimeHeader } from '../../src/lib/mime-header.js';

describe('decodeMimeHeader', () => {
	it('returns plain or empty header values unchanged', () => {
		expect(decodeMimeHeader('Your receipt')).toBe('Your receipt');
		expect(decodeMimeHeader(null)).toBe('');
		expect(decodeMimeHeader(undefined)).toBe('');
		expect(decodeMimeHeader('')).toBe('');
	});

	it('decodes base64 encoded-words', () => {
		expect(decodeMimeHeader('=?UTF-8?B?5rOo5paH44GC44KK44GM44Go44GG44GU44GW44GE44G+44GZ?=')).toBe(
			'注文ありがとうございます'
		);
	});

	it('decodes quoted-printable encoded-words, including underscore as space', () => {
		expect(decodeMimeHeader('=?UTF-8?q?=E3=80=90=E3=83=A1=E3=83=AB=E3=82=AB=E3=83=AA=E3=80=91?=')).toBe(
			'【メルカリ】'
		);
		expect(decodeMimeHeader('=?UTF-8?Q?Order_shipped?=')).toBe('Order shipped');
	});

	it('decodes legacy charsets such as ISO-2022-JP', () => {
		expect(decodeMimeHeader('=?iso-2022-jp?B?GyRCJUYlOSVIGyhC?=')).toBe('テスト');
	});

	it('drops whitespace that only separates two adjacent encoded-words', () => {
		expect(decodeMimeHeader('=?UTF-8?B?44GT44KT44Gr44Gh44Gv?= =?UTF-8?B?5LiW55WM?=')).toBe(
			'こんにちは世界'
		);
	});

	it('keeps plain text around an encoded-word', () => {
		expect(decodeMimeHeader('Re: =?UTF-8?B?5LiW55WM?= (2)')).toBe('Re: 世界 (2)');
	});

	it('leaves encoded-words it cannot decode untouched', () => {
		const unknownCharset = '=?x-made-up?B?5LiW55WM?=';
		const badBase64 = '=?UTF-8?B?not base64!?=';
		const badQuotedPrintable = '=?UTF-8?Q?=ZZ?=';
		expect(decodeMimeHeader(unknownCharset)).toBe(unknownCharset);
		expect(decodeMimeHeader(badBase64)).toBe(badBase64);
		expect(decodeMimeHeader(badQuotedPrintable)).toBe(badQuotedPrintable);
	});

	it('decodes UTF-8 bytes that were mislabeled as a single-byte charset', () => {
		expect(decodeMimeHeader('=?us-ascii?B?5LiW55WM?=')).toBe('世界');
		expect(decodeMimeHeader('=?iso-8859-1?Q?caf=E9?=')).toBe('café');
	});

	it('leaves bytes that do not fit a multi-byte charset untouched', () => {
		const mismatched = '=?iso-2022-jp?B?/////w==?=';
		expect(decodeMimeHeader(mismatched)).toBe(mismatched);
	});

	it('decodes a value that is already plain text idempotently', () => {
		const once = decodeMimeHeader('=?UTF-8?B?5LiW55WM?=');
		expect(decodeMimeHeader(once)).toBe(once);
	});
});
