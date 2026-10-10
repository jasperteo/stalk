/**
 * @module
 *
 * PNG bytes in and out, without an image library: {@link encodePng} wraps ready-made scanlines in the
 * PNG container, and {@link decodePng} turns any PNG that fast-png reads into plain 8-bit RGBA.
 *
 * The encoder never touches pixels. `deck-image.ts` composes a deck straight into PNG scanlines
 * (a filter byte of 0, then the row's RGBA bytes), so encoding is a zlib wrapper plus chunk
 * framing. Nothing here needs a native addon, so it runs wherever `node:zlib` does.
 *
 * The decoder reads every PNG the app handles: the art in `images/` when `pnpm tiles` builds the
 * tiles, and at runtime the CDN art for a card with no tile. It accepts every color type and bit depth fast-png decodes, except grayscale below 8 bits, and
 * always returns unpremultiplied RGBA with no row padding, which is what the tile code reads.
 */

import { crc32, deflateSync } from "node:zlib";

import type { DecodedPng } from "fast-png";
import { convertIndexedToRgb, decode } from "fast-png";

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The deflate level for the image data. Level 0 emits stored blocks, so the "compression" is a copy
 * plus an Adler-32 checksum. Measured locally with `node:zlib` on the `pnpm preview` deck:
 *
 * - Level 0: 3.27 MiB, 0.6 ms of CPU.
 * - Level 6: 1.42 MiB, 26.8 ms.
 * - Level 9: 1.40 MiB, 50.8 ms.
 *
 * The PNG is lossless at every level, so the choice only trades upload size against CPU time. Deno
 * Deploy bills CPU time, and Cloudflare Workers caps it per invocation, while the size has room: a
 * post carries two grids, about 6.6 MiB, against Discord's limits of 20 MiB per file and 25 MiB per
 * request.
 */
const DEFLATE_LEVEL = 0;

/** The 8 bytes that open every PNG file. */
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The IHDR body is always 13 bytes: width, height, then five single-byte fields. */
const IHDR_LENGTH = 13;

/**
 * The bytes a chunk adds around its body: a 4-byte length in front, then a 4-byte type, and a
 * 4-byte CRC after. The length counts only the body.
 */
const CHUNK_OVERHEAD = 12;

/** Color type 6 in IHDR: each pixel is red, green, blue and alpha. */
const COLOR_TYPE_RGBA = 6;

/** Bit depth of each channel in the encoder's output. */
const BIT_DEPTH = 8;

/** Encodes chunk type names such as `IHDR` into their 4 ASCII bytes. */
const textEncoder = new TextEncoder();

// ═══════════════════════════════════════════ ENCODING ════════════════════════════════════════════

/**
 * Writes one chunk (length, type, body, CRC) at `offset` and returns the offset after it. The CRC
 * covers the type and the body, which sit next to each other in `out`, so it is computed over one
 * subarray.
 */
function writeChunk(
	out: Uint8Array,
	view: DataView,
	offset: number,
	type: string,
	body: Uint8Array
) {
	const typeStart = offset + 4;
	const bodyStart = typeStart + 4;
	const bodyEnd = bodyStart + body.length;

	view.setUint32(offset, body.length);
	out.set(textEncoder.encode(type), typeStart);
	out.set(body, bodyStart);
	view.setUint32(bodyEnd, crc32(out.subarray(typeStart, bodyEnd)));

	return bodyEnd + 4;
}

/**
 * Wraps PNG scanlines into a complete 8-bit RGBA PNG: signature, IHDR, one IDAT, IEND. `scanlines`
 * holds `height` rows of one filter byte (always 0 here, meaning unfiltered) followed by `width *
 * 4` bytes of unpremultiplied RGBA, so its length must be `(width * 4 + 1) * height`; anything else
 * throws.
 *
 * The result is a fresh `Uint8Array` over its own `ArrayBuffer`, which `File` and `Response` accept
 * as a body.
 */
function encodePng(scanlines: Uint8Array, width: number, height: number) {
	const expected = (width * 4 + 1) * height;

	if (scanlines.length !== expected) {
		throw new RangeError(
			`${String(width)}×${String(height)} RGBA needs ${String(expected)} scanline bytes, got ${String(scanlines.length)}`
		);
	}

	const idat = deflateSync(scanlines, { level: DEFLATE_LEVEL });
	const out = new Uint8Array(
		SIGNATURE.length +
			(CHUNK_OVERHEAD + IHDR_LENGTH) +
			(CHUNK_OVERHEAD + idat.length) +
			CHUNK_OVERHEAD
	);
	const view = new DataView(out.buffer);

	const ihdr = new Uint8Array(IHDR_LENGTH);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, width);
	ihdrView.setUint32(4, height);
	// Compression, filter method and interlace stay 0: deflate, adaptive filtering, no interlace.
	ihdr.set([BIT_DEPTH, COLOR_TYPE_RGBA], 8);

	out.set(SIGNATURE);
	let offset = SIGNATURE.length;
	offset = writeChunk(out, view, offset, "IHDR", ihdr);
	offset = writeChunk(out, view, offset, "IDAT", idat);
	writeChunk(out, view, offset, "IEND", new Uint8Array(0));

	return out;
}

// ═══════════════════════════════════════════ DECODING ════════════════════════════════════════════

/**
 * Expands `count` pixels of decoded samples, 1 to 4 channels at 8 or 16 bits, into RGBA. Palette
 * lookups reach it as 8-bit, 3-channel data with no key.
 *
 * - 16-bit samples arrive as native-endian `Uint16Array` values and drop to 8 bits with `>> 8`.
 * - A tRNS color key (grayscale and RGB only; fast-png reports it as `transparency`) makes every
 *   pixel equal to the key fully transparent. The comparison uses the samples at their native
 *   depth, before any reduction, as the PNG spec defines it: a 16-bit pixel that matches the key
 *   only in its high byte stays opaque.
 * - Images without alpha get 255.
 */
function expandSamples(
	src: DecodedPng["data"],
	channels: number,
	depth: number,
	transparency: DecodedPng["transparency"],
	count: number
) {
	const shift = depth === 16 ? 8 : 0;
	const out = new Uint8Array(count * 4);

	switch (channels) {
		case 1: {
			const key = transparency?.[0];
			for (let i = 0; i < count; i++) {
				const v = src[i] ?? 0;
				const gray = v >> shift;
				const o = i * 4;
				out[o] = gray;
				out[o + 1] = gray;
				out[o + 2] = gray;
				out[o + 3] = v === key ? 0 : 255;
			}
			break;
		}
		case 2: {
			for (let i = 0; i < count; i++) {
				const s = i * 2;
				const o = i * 4;
				const gray = (src[s] ?? 0) >> shift;
				out[o] = gray;
				out[o + 1] = gray;
				out[o + 2] = gray;
				out[o + 3] = (src[s + 1] ?? 0) >> shift;
			}
			break;
		}
		case 3: {
			const keyR = transparency?.[0];
			const keyG = transparency?.[1];
			const keyB = transparency?.[2];
			for (let i = 0; i < count; i++) {
				const s = i * 3;
				const o = i * 4;
				const r = src[s] ?? 0;
				const g = src[s + 1] ?? 0;
				const b = src[s + 2] ?? 0;
				out[o] = r >> shift;
				out[o + 1] = g >> shift;
				out[o + 2] = b >> shift;
				out[o + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
			}
			break;
		}
		case 4: {
			for (let i = 0; i < count * 4; i++) {
				out[i] = (src[i] ?? 0) >> shift;
			}
			break;
		}
		default: {
			throw new Error(`Unsupported PNG channel count: ${String(channels)}`);
		}
	}

	return out;
}

/**
 * Decodes any PNG fast-png reads into 8-bit, unpremultiplied RGBA with no row padding.
 *
 * An 8-bit RGBA PNG, which is every card image, is returned as fast-png decoded it, without a copy.
 * Every other format is expanded into a new array.
 *
 * Palette images go through fast-png's `convertIndexedToRgb`, which yields 3 bytes per pixel, or 4
 * when the PNG has a tRNS chunk (fast-png appends each entry's alpha to the palette). Only
 * single-channel data with a palette is indexed: a truecolor PNG may carry a PLTE chunk as a color
 * hint, and fast-png reports `palette` for it too. Grayscale below 8 bits throws, because the CDN
 * serves 8-bit RGBA art, and the caller answers a throw by posting text only. Bytes that are not a
 * PNG make fast-png throw.
 */
function decodePng(bytes: Uint8Array) {
	const decoded = decode(bytes);
	const { width, height, channels, depth, palette } = decoded;

	if (channels === 4 && depth === 8 && decoded.data instanceof Uint8Array) {
		return { data: decoded.data, width, height };
	}

	const count = width * height;

	if (channels === 1 && palette !== undefined) {
		const rgb = convertIndexedToRgb(decoded);

		return {
			data: rgb.length === count * 4 ? rgb : expandSamples(rgb, 3, 8, undefined, count),
			width,
			height,
		};
	}

	if (depth < 8) {
		throw new Error(`Unsupported PNG bit depth: ${String(depth)} without a palette`);
	}

	return {
		data: expandSamples(decoded.data, channels, depth, decoded.transparency, count),
		width,
		height,
	};
}

export { decodePng, encodePng };
