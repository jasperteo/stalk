/**
 * @module
 *
 * Tests for `tile.ts`. They build raw pixels directly, so no image library is involved.
 */

import { describe, expect, test } from "vitest";

import { pixelAt, solidRaw } from "@/testing/raw.ts";
import type { RawImage, Tile } from "@/tile.ts";
import {
	ALPHA_THRESHOLD,
	cropRaw,
	parseTile,
	scanArtBounds,
	serializeTile,
	shrinkToFit,
	trimRaw,
} from "@/tile.ts";

/**
 * A pixel painted in its own color, so a test can tell where cropped bytes came from. The fill of
 * an {@link insetFixture} is one flat color, so without marks a crop taken at the wrong offset would
 * return the same bytes as the right one.
 */
type Mark = { x: number; y: number; color: [r: number, g: number, b: number] };

/**
 * A transparent `width`×`height` bitmap with an opaque rectangle at `rect` and optional marked
 * pixels. The transparent margin around `rect` gives `scanArtBounds` and `cropRaw` a real crop to
 * make, and the test knows the expected bounds because it chose `rect`.
 */
function insetFixture(
	width: number,
	height: number,
	rect: { left: number; top: number; width: number; height: number },
	marks: Mark[] = []
): RawImage {
	const data = new Uint8Array(width * height * 4);

	for (let y = rect.top; y < rect.top + rect.height; y++) {
		for (let x = rect.left; x < rect.left + rect.width; x++) {
			const offset = (y * width + x) * 4;
			data[offset] = 200;
			data[offset + 1] = 30;
			data[offset + 2] = 30;
			data[offset + 3] = 255;
		}
	}

	// Marks are painted after the fill, so a mark inside `rect` replaces the fill color.
	for (const { x, y, color } of marks) {
		const offset = (y * width + x) * 4;
		[data[offset], data[offset + 1], data[offset + 2]] = color;
		data[offset + 3] = 255;
	}

	return { data, width, height };
}

/** A 3×2 tile whose bytes are all different, so a misplaced byte shows up in a comparison. */
function sampleTile(): Tile {
	return {
		data: Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => i + 1),
		width: 3,
		height: 2,
		bottomPadding: 1,
	};
}

/** A 3×3 bitmap that is transparent except for the center pixel, which has `alpha`. */
function centerPixel(alpha: number): RawImage {
	const raw = solidRaw(3, 3, [0, 0, 0, 0]);
	raw.data[(1 * 3 + 1) * 4 + 3] = alpha;
	return raw;
}

describe("trimRaw", () => {
	// A 30×40 canvas whose opaque rectangle ends exactly at the canvas's right edge
	// (left + width === canvas width), the boundary `cropRaw`'s bounds check must accept. Trimming
	// keeps the bottom edge, so the tile always reaches the bottom of the canvas; only the left, top
	// and right are trimmed.
	const CANVAS_WIDTH = 30;
	const CANVAS_HEIGHT = 40;
	const RECT = { left: 5, top: 8, width: CANVAS_WIDTH - 5, height: 20 };

	// Two marked pixels that leave the bounds unchanged. ORIGIN is the rectangle's top-left corner,
	// which is also the crop's first pixel. LAST_ROW is in the canvas's bottom row, below the
	// rectangle but in the same column, which the kept bottom edge includes anyway.
	const ORIGIN: Mark = { x: RECT.left, y: RECT.top, color: [10, 20, 30] };
	const LAST_ROW: Mark = { x: RECT.left, y: CANVAS_HEIGHT - 1, color: [40, 50, 60] };

	test("crops the art's own region, byte for byte, when it touches the right edge of the frame", () => {
		const raw = insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT, [ORIGIN, LAST_ROW]);

		const tile = trimRaw(raw);

		// The left edge moves in to the rectangle, the right edge stays at the canvas edge, and the
		// height runs from the rectangle's top to the bottom of the canvas.
		expect(tile.width).toBe(CANVAS_WIDTH - RECT.left);
		expect(tile.height).toBe(CANVAS_HEIGHT - RECT.top);
		expect(tile.data.length).toBe(tile.width * tile.height * 4);
		// LAST_ROW is opaque art in the bottom row, so no transparent rows remain below it.
		expect(tile.bottomPadding).toBe(0);

		// The size checks cannot see `cropRaw`'s copy loop, because the output is sized before the
		// loop runs. These two pixels check the bytes. The first fails if the copy ignores
		// `region.left` or `region.top`, since it would read a transparent pixel. The second fails if
		// the loop stops a row early, leaving zeros.
		expect(pixelAt(tile, 0, 0)).toEqual([...ORIGIN.color, 255]);
		expect(pixelAt(tile, 0, tile.height - 1)).toEqual([...LAST_ROW.color, 255]);
	});

	test("keeps the whole frame for a fully transparent tile", () => {
		// `scanArtBounds` returns `undefined` for a blank image. Real card art is never blank, but
		// the tile must still be the whole frame: an empty crop would give the compositor a
		// zero-byte input and fail the render.
		const blank = insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, {
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		});

		const tile = trimRaw(blank);

		expect(tile.width).toBe(CANVAS_WIDTH);
		expect(tile.height).toBe(CANVAS_HEIGHT);
		expect(tile.data.length).toBe(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
		// Every row counts as padding, so a blank tile never triggers the clip warning.
		expect(tile.bottomPadding).toBe(CANVAS_HEIGHT);
	});
});

describe("scanArtBounds", () => {
	test("counts alpha at the threshold as transparent and one above as art", () => {
		expect(ALPHA_THRESHOLD).toBe(8);
		expect(scanArtBounds(centerPixel(ALPHA_THRESHOLD))).toBeUndefined();
		expect(scanArtBounds(centerPixel(ALPHA_THRESHOLD + 1))).toEqual({
			minX: 1,
			minY: 1,
			maxX: 1,
			maxY: 1,
		});
	});

	test("returns undefined for a fully transparent bitmap", () => {
		expect(scanArtBounds(solidRaw(4, 4, [255, 255, 255, 0]))).toBeUndefined();
	});
});

describe("cropRaw", () => {
	const source = insetFixture(4, 4, { left: 0, top: 0, width: 4, height: 4 });

	test.each([
		["a negative left", { left: -1, top: 0, width: 2, height: 2 }],
		["a negative top", { left: 0, top: -1, width: 2, height: 2 }],
		["a negative width", { left: 0, top: 0, width: -1, height: 2 }],
		["a negative height", { left: 0, top: 0, width: 2, height: -1 }],
		["a region past the right edge", { left: 3, top: 0, width: 2, height: 2 }],
		["a region past the bottom edge", { left: 0, top: 3, width: 2, height: 2 }],
	])("throws for %s", (_name, region) => {
		expect(() => cropRaw(source, region)).toThrow("exceeds");
	});

	test("accepts a region that ends exactly at the right and bottom edges", () => {
		expect(cropRaw(source, { left: 2, top: 2, width: 2, height: 2 }).length).toBe(2 * 2 * 4);
	});
});

describe("serializeTile and parseTile", () => {
	test("round-trips a tile", () => {
		const tile = sampleTile();

		const parsed = parseTile(serializeTile(tile));

		expect(parsed.width).toBe(tile.width);
		expect(parsed.height).toBe(tile.height);
		expect(parsed.bottomPadding).toBe(tile.bottomPadding);
		expect([...parsed.data]).toEqual([...tile.data]);
	});

	test("writes the magic and big-endian header fields", () => {
		const bytes = serializeTile({ ...sampleTile(), width: 3, height: 2, bottomPadding: 1 });

		expect([...bytes.subarray(0, 10)]).toEqual([0x53, 0x54, 0x4b, 0x31, 0, 3, 0, 2, 0, 1]);
	});

	test("parses a view with a non-zero byte offset", () => {
		const bytes = serializeTile(sampleTile());
		const padded = new Uint8Array(bytes.length + 7);
		padded.set(bytes, 5);

		const parsed = parseTile(padded.subarray(5, 5 + bytes.length));

		expect(parsed.width).toBe(3);
		expect(parsed.height).toBe(2);
		expect(parsed.bottomPadding).toBe(1);
		expect([...parsed.data]).toEqual([...sampleTile().data]);
	});

	test("returns data as a view of the input, not a copy", () => {
		const bytes = serializeTile(sampleTile());

		expect(parseTile(bytes).data.buffer).toBe(bytes.buffer);
	});

	test("throws on a wrong magic", () => {
		const bytes = serializeTile(sampleTile());
		bytes[3] = 0x32;

		expect(() => parseTile(bytes)).toThrow("magic");
	});

	test("throws on a buffer shorter than the header", () => {
		expect(() => parseTile(new Uint8Array(9))).toThrow("header");
	});

	test("throws when the body is too short", () => {
		const bytes = serializeTile(sampleTile());

		expect(() => parseTile(bytes.subarray(0, -1))).toThrow("body");
	});

	test("throws when the body is too long", () => {
		const bytes = serializeTile(sampleTile());
		const longer = new Uint8Array(bytes.length + 1);
		longer.set(bytes);

		expect(() => parseTile(longer)).toThrow("body");
	});

	test("serialize throws when the data length does not match the size", () => {
		expect(() => serializeTile({ ...sampleTile(), width: 4 })).toThrow("bytes");
	});

	test("serialize throws when a dimension exceeds a uint16", () => {
		expect(() =>
			serializeTile({ data: new Uint8Array(0), width: 0, height: 0, bottomPadding: 65_536 })
		).toThrow("uint16");
	});
});

describe("shrinkToFit", () => {
	test("returns the same object when the bitmap already fits", () => {
		const raw = solidRaw(10, 20, [1, 2, 3, 255]);

		expect(shrinkToFit(raw, 10, 20)).toBe(raw);
		expect(shrinkToFit(raw, 50, 50)).toBe(raw);
	});

	test("fits an oversized bitmap inside the maximum and keeps its aspect ratio", () => {
		const raw = solidRaw(301, 480, [200, 30, 30, 255]);

		const shrunk = shrinkToFit(raw, 261, 405);

		expect(shrunk.width).toBeLessThanOrEqual(261);
		expect(shrunk.height).toBeLessThanOrEqual(405);
		expect(shrunk.data.length).toBe(shrunk.width * shrunk.height * 4);
		expect(
			Math.abs(shrunk.width / shrunk.height - raw.width / raw.height) * shrunk.height
		).toBeLessThanOrEqual(1);
	});

	test("keeps a uniform opaque color unchanged", () => {
		const shrunk = shrinkToFit(solidRaw(37, 23, [200, 30, 30, 255]), 10, 10);

		for (let y = 0; y < shrunk.height; y++) {
			for (let x = 0; x < shrunk.width; x++) {
				expect(pixelAt(shrunk, x, y)).toEqual([200, 30, 30, 255]);
			}
		}
	});

	test("weights color by alpha so a transparent neighbor does not darken it", () => {
		const raw: RawImage = {
			data: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]),
			width: 2,
			height: 1,
		};

		const [r, g, b, a] = pixelAt(shrinkToFit(raw, 1, 1), 0, 0);

		expect([r, g, b]).toEqual([255, 0, 0]);
		expect(a).toBeGreaterThanOrEqual(127);
		expect(a).toBeLessThanOrEqual(129);
	});

	test("never shrinks a dimension to zero", () => {
		const shrunk = shrinkToFit(solidRaw(1000, 2, [9, 9, 9, 255]), 10, 10);

		expect(shrunk.width).toBe(10);
		expect(shrunk.height).toBe(1);
	});
});
