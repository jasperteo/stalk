/**
 * @module
 *
 * Tests for `png.ts`. PNGs for the decoder are built by hand from explicit chunks, so each test
 * picks its color type, bit depth, PLTE and tRNS. fast-png is called directly only where it is the
 * independent party: {@link decodeChecked} reads what the hand-written `encodePng` wrote, and the
 * Adam7 test has it write an interlaced file.
 */

import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";

import { decode, encode } from "fast-png";
import { describe, expect, test } from "vitest";

import { decodePng, encodePng } from "@/png.ts";
import {
	buildPng,
	GRAY,
	GRAY_ALPHA,
	PALETTE,
	RGB,
	RGBA,
	SIGNATURE,
	toScanlines,
} from "@/testing/png.ts";

/** Decodes `png` and returns the pixels as a plain array, for readable failures. */
function decodeToArray(png: Uint8Array) {
	const { data, width, height } = decodePng(png);

	return { pixels: [...data], width, height };
}

/**
 * Decodes with fast-png directly, CRC checks on. It is the independent reader for what `encodePng`
 * wrote: `decodePng` would hide a wrong color type or depth behind its normalization, and fast-png
 * skips CRC checks by default.
 */
function decodeChecked(png: Uint8Array) {
	return decode(png, { checkCrc: true });
}

/** Deterministic RGBA noise with non-zero alpha, `width * height * 4` bytes. */
function pixelsOf(width: number, height: number) {
	const rgba = new Uint8Array(width * height * 4);

	for (let i = 0; i < rgba.length; i++) {
		rgba[i] = (i * 37 + 11) % 251;
		if (i % 4 === 3) {
			rgba[i] = 1 + (i % 250);
		}
	}

	return rgba;
}

/** Every chunk of `png`, with the CRC it stores and the CRC of its type and body. */
function readChunks(png: Uint8Array) {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks = [];
	let offset = SIGNATURE.length;

	while (offset < png.length) {
		const length = view.getUint32(offset);
		const typed = png.subarray(offset + 4, offset + 8 + length);
		chunks.push({
			type: Buffer.from(typed.subarray(0, 4)).toString("ascii"),
			body: typed.subarray(4),
			storedCrc: view.getUint32(offset + 8 + length),
			actualCrc: crc32(typed),
		});
		offset += 12 + length;
	}

	return chunks;
}

describe("encodePng", () => {
	test("writes the PNG signature", () => {
		const png = encodePng(toScanlines(pixelsOf(2, 2), 2, 2), 2, 2);

		expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
	});

	test("writes IHDR, one IDAT and IEND, in that order", () => {
		const png = encodePng(toScanlines(pixelsOf(3, 2), 3, 2), 3, 2);

		expect(readChunks(png).map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
	});

	test("describes the image as 8-bit RGBA with no interlacing", () => {
		const png = encodePng(toScanlines(pixelsOf(300, 2), 300, 2), 300, 2);
		const ihdr = readChunks(png)[0]?.body;
		const view = new DataView(ihdr?.buffer ?? new ArrayBuffer(0), ihdr?.byteOffset, 13);

		expect(view.getUint32(0)).toBe(300);
		expect(view.getUint32(4)).toBe(2);
		expect([...(ihdr?.subarray(8) ?? [])]).toEqual([8, 6, 0, 0, 0]);
	});

	test("stores a valid CRC on every chunk", () => {
		const png = encodePng(toScanlines(pixelsOf(5, 4), 5, 4), 5, 4);

		for (const c of readChunks(png)) {
			expect([c.type, c.storedCrc]).toEqual([c.type, c.actualCrc]);
		}
	});

	test("ends with the standard IEND chunk", () => {
		const png = encodePng(toScanlines(pixelsOf(1, 1), 1, 1), 1, 1);

		expect([...png.subarray(-12)]).toEqual([
			0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
	});

	test("does not compress the image data", () => {
		const scanlines = new Uint8Array((64 * 4 + 1) * 64);
		const idat = readChunks(encodePng(scanlines, 64, 64)).find((c) => c.type === "IDAT");

		expect(idat?.body.length).toBeGreaterThan(scanlines.length);
	});

	test("decodes, CRCs checked, to exactly the input pixels", () => {
		const [width, height] = [37, 19];
		const rgba = pixelsOf(width, height);
		const png = encodePng(toScanlines(rgba, width, height), width, height);

		const decoded = decodeChecked(png);

		expect([decoded.width, decoded.height, decoded.channels, decoded.depth]).toEqual([
			width,
			height,
			4,
			8,
		]);
		expect([...decoded.data]).toEqual([...rgba]);
	});

	test("encodes a 1×1 image", () => {
		const rgba = Uint8Array.of(10, 20, 30, 40);
		const png = encodePng(toScanlines(rgba, 1, 1), 1, 1);

		expect([...decodeChecked(png).data]).toEqual([10, 20, 30, 40]);
	});

	test("encodes a fully transparent image", () => {
		const [width, height] = [8, 8];
		const png = encodePng(new Uint8Array((width * 4 + 1) * height), width, height);

		expect(decodeChecked(png).data.every((byte) => byte === 0)).toBe(true);
	});

	test("returns a Uint8Array that owns its buffer", () => {
		const png = encodePng(toScanlines(pixelsOf(2, 2), 2, 2), 2, 2);

		expect(png).toBeInstanceOf(Uint8Array);
		expect(png.byteOffset).toBe(0);
		expect(png.buffer.byteLength).toBe(png.length);
	});

	test("throws when the scanlines do not match the size", () => {
		expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow(/needs 18 scanline bytes, got 10/);
		// Pixels without the filter bytes are one byte short for every row.
		expect(() => encodePng(pixelsOf(2, 2), 2, 2)).toThrow(RangeError);
	});
});

describe("decodePng", () => {
	test("returns 8-bit RGBA unchanged", () => {
		const samples = [1, 2, 3, 4, 5, 6, 7, 8];
		const png = buildPng({ width: 2, height: 1, colorType: RGBA, depth: 8, samples });

		expect(decodeToArray(png)).toEqual({ pixels: samples, width: 2, height: 1 });
	});

	test("gives RGB an opaque alpha", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: RGB,
			depth: 8,
			samples: [1, 2, 3, 4, 5, 6],
		});

		expect(decodeToArray(png).pixels).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	test("makes only the tRNS color key transparent in RGB", () => {
		const png = buildPng({
			width: 3,
			height: 1,
			colorType: RGB,
			depth: 8,
			samples: [1, 2, 3, 1, 2, 4, 9, 9, 9],
			trns: [0, 1, 0, 2, 0, 3],
		});

		expect(decodeToArray(png).pixels).toEqual([1, 2, 3, 0, 1, 2, 4, 255, 9, 9, 9, 255]);
	});

	test("expands grayscale", () => {
		const png = buildPng({ width: 2, height: 1, colorType: GRAY, depth: 8, samples: [7, 200] });

		expect(decodeToArray(png).pixels).toEqual([7, 7, 7, 255, 200, 200, 200, 255]);
	});

	test("makes only the tRNS gray key transparent in grayscale", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: GRAY,
			depth: 8,
			samples: [7, 200],
			trns: [0, 7],
		});

		expect(decodeToArray(png).pixels).toEqual([7, 7, 7, 0, 200, 200, 200, 255]);
	});

	test("expands grayscale with alpha", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: GRAY_ALPHA,
			depth: 8,
			samples: [7, 100, 200, 50],
		});

		expect(decodeToArray(png).pixels).toEqual([7, 7, 7, 100, 200, 200, 200, 50]);
	});

	test("reduces 16-bit RGBA to its high bytes", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: RGBA,
			depth: 16,
			samples: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xff, 0, 1, 0xff, 0xff, 0x80, 0, 0, 0xff],
		});

		expect(decodeToArray(png).pixels).toEqual([0x12, 0x56, 0x9a, 0xde, 0, 0xff, 0x80, 0]);
	});

	test("compares the 16-bit tRNS key at 16 bits", () => {
		const png = buildPng({
			width: 3,
			height: 1,
			colorType: RGB,
			depth: 16,
			samples: [
				// Matches the key exactly.
				0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc,
				// Matches in every high byte only.
				0x12, 0x00, 0x56, 0x00, 0x9a, 0x00,
				// Matches in two channels.
				0x12, 0x34, 0x56, 0x78, 0x9a, 0xbd,
			],
			trns: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc],
		});

		expect(decodeToArray(png).pixels).toEqual([
			0x12, 0x56, 0x9a, 0, 0x12, 0x56, 0x9a, 255, 0x12, 0x56, 0x9a, 255,
		]);
	});

	test("reduces 16-bit grayscale with a key", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: GRAY,
			depth: 16,
			samples: [0xab, 0xcd, 0xab, 0xce],
			trns: [0xab, 0xcd],
		});

		expect(decodeToArray(png).pixels).toEqual([0xab, 0xab, 0xab, 0, 0xab, 0xab, 0xab, 255]);
	});

	test("looks up palette entries, opaque without tRNS", () => {
		const png = buildPng({
			width: 3,
			height: 1,
			colorType: PALETTE,
			depth: 8,
			samples: [2, 0, 1],
			plte: [10, 11, 12, 20, 21, 22, 30, 31, 32],
		});

		expect(decodeToArray(png).pixels).toEqual([30, 31, 32, 255, 10, 11, 12, 255, 20, 21, 22, 255]);
	});

	test("takes palette alpha from tRNS, with entries past it opaque", () => {
		const png = buildPng({
			width: 3,
			height: 1,
			colorType: PALETTE,
			depth: 8,
			samples: [0, 1, 2],
			plte: [10, 11, 12, 20, 21, 22, 30, 31, 32],
			trns: [0, 128],
		});

		expect(decodeToArray(png).pixels).toEqual([10, 11, 12, 0, 20, 21, 22, 128, 30, 31, 32, 255]);
	});

	test("unpacks a 2-bit palette", () => {
		// Indexes 0, 1, 2 packed as 00 01 10 and padded.
		const png = buildPng({
			width: 3,
			height: 1,
			colorType: PALETTE,
			depth: 2,
			samples: [0b0001_1000],
			plte: [1, 1, 1, 2, 2, 2, 3, 3, 3],
		});

		expect(decodeToArray(png).pixels).toEqual([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]);
	});

	test("treats an RGB image with a PLTE chunk as RGB", () => {
		const png = buildPng({
			width: 2,
			height: 1,
			colorType: RGB,
			depth: 8,
			samples: [1, 2, 3, 4, 5, 6],
			plte: [200, 200, 200, 100, 100, 100],
		});

		expect(decodeToArray(png).pixels).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
	});

	test("decodes an Adam7 interlaced PNG to the same pixels", () => {
		const [width, height] = [9, 11];
		const rgba = pixelsOf(width, height);
		const png = encode(
			{ width, height, data: rgba, channels: 4, depth: 8 },
			{ interlace: "Adam7" }
		);

		// The interlace byte of IHDR sits at offset 28.
		expect(png[28]).toBe(1);
		expect(decodeToArray(png)).toEqual({ pixels: [...rgba], width, height });
	});

	test("throws for grayscale below 8 bits", () => {
		const png = buildPng({
			width: 4,
			height: 1,
			colorType: GRAY,
			depth: 4,
			samples: [0x12, 0x30],
		});

		expect(() => decodePng(png)).toThrow(/bit depth: 4/);
	});

	test("throws for bytes that are not a PNG", () => {
		expect(() => decodePng(Buffer.from("definitely not a png"))).toThrow(/.+/);
		expect(() => decodePng(new Uint8Array(0))).toThrow(/.+/);
	});
});

describe("encodePng and decodePng", () => {
	test("round-trip the pixels", () => {
		const [width, height] = [23, 14];
		const rgba = pixelsOf(width, height);

		const decoded = decodeToArray(encodePng(toScanlines(rgba, width, height), width, height));

		expect(decoded).toEqual({ pixels: [...rgba], width, height });
	});
});
