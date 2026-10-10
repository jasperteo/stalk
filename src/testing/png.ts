/**
 * @module
 *
 * Hand-built PNGs for tests of the decoder and the renderer. {@link buildPng} writes any color type
 * and bit depth from explicit samples, which `encodePng` cannot, and {@link toScanlines} turns RGBA
 * pixels into the scanlines `encodePng` takes.
 */

import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";

/** The 8 bytes that open every PNG file. */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The IHDR color types the tests build. */
const GRAY = 0;
const RGB = 2;
const PALETTE = 3;
const GRAY_ALPHA = 4;
const RGBA = 6;

type PngSpec = {
	width: number;
	height: number;
	colorType: number;
	depth: number;
	/** The packed bytes of every row, end to end and without filter bytes. */
	samples: number[];
	/** PLTE entries as flat `r, g, b` triples. */
	plte?: number[];
	/** The tRNS body, as bytes. */
	trns?: number[];
};

/** One chunk: length, type, body and a CRC over type and body. */
function chunk(type: string, body: Uint8Array = new Uint8Array(0)) {
	const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
	const out = Buffer.alloc(typed.length + 8);

	out.writeUInt32BE(body.length, 0);
	typed.copy(out, 4);
	out.writeUInt32BE(crc32(typed), typed.length + 4);

	return out;
}

/** Hand-builds an unfiltered, non-interlaced PNG from packed rows, with optional PLTE and tRNS. */
function buildPng(spec: PngSpec) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(spec.width, 0);
	ihdr.writeUInt32BE(spec.height, 4);
	ihdr[8] = spec.depth;
	ihdr[9] = spec.colorType;

	const rowBytes = spec.samples.length / spec.height;
	const filtered: number[] = [];
	for (let y = 0; y < spec.height; y++) {
		filtered.push(0, ...spec.samples.slice(y * rowBytes, (y + 1) * rowBytes));
	}

	return Buffer.concat([
		Buffer.from(SIGNATURE),
		chunk("IHDR", ihdr),
		...(spec.plte ? [chunk("PLTE", Buffer.from(spec.plte))] : []),
		...(spec.trns ? [chunk("tRNS", Buffer.from(spec.trns))] : []),
		chunk("IDAT", deflateSync(Buffer.from(filtered))),
		chunk("IEND"),
	]);
}

/** Scanlines for `rgba`: a 0 filter byte before each row, as `encodePng` takes them. */
function toScanlines(rgba: Uint8Array, width: number, height: number) {
	const stride = width * 4;
	const out = new Uint8Array((stride + 1) * height);

	for (let y = 0; y < height; y++) {
		out.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}

	return out;
}

export { buildPng, GRAY, GRAY_ALPHA, PALETTE, RGB, RGBA, SIGNATURE, toScanlines };
export type { PngSpec };
