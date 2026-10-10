/**
 * @module
 *
 * Tests for `deck-image.ts`, with synthetic RGBA fixtures instead of real card art. `Deno.readFile`
 * is spied to serve `.tile` files built with `serializeTile`, and `fetch` is stubbed to serve CDN
 * PNGs built with `encodePng` or by hand, so no test reads `tiles/` or touches the network. Rendered
 * grids are decoded with `decodePng` to inspect their pixels.
 *
 * Trimming itself is tested in `tile.test.ts`. None of this checks real card art; after a change to
 * trimming or compositing, render the sample deck with `pnpm preview` and look at it.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	CELL_HEIGHT,
	CELL_WIDTH,
	compositeScanlines,
	planGrid,
	renderDeckGrid,
} from "@/deck-image.ts";
import { log } from "@/log.ts";
import { decodePng, encodePng } from "@/png.ts";
import type { Card } from "@/schema.ts";
import { buildPng, PALETTE, RGBA, toScanlines } from "@/testing/png.ts";
import { pixelAt, solidRaw } from "@/testing/raw.ts";
import type { RawImage, Tile } from "@/tile.ts";
import { serializeTile } from "@/tile.ts";

vi.mock(import("@/log.ts"));

// Every `card()` call gets a new id, so cards from different tests never share one. A test that
// renders the same deck twice builds the array once and passes it both times.
let nextId = 1;

/** A validated card with a fresh id; an ordinary Knight unless overridden. */
function card(overrides: Partial<Card> = {}): Card {
	return {
		id: nextId++,
		name: "Knight",
		evolutionLevel: undefined,
		iconUrls: { medium: "https://api.clashroyale.com/knight.png" },
		...overrides,
	};
}

/** One pixel's red, green, blue and alpha. */
type Rgba = [r: number, g: number, b: number, a: number];

const TILE_WIDTH = 20;
const TILE_HEIGHT = 30;
const RED: Rgba = [200, 30, 30, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** Paints one pixel of a raw bitmap or tile. */
function paint({ data, width }: RawImage, x: number, y: number, color: Rgba) {
	data.set(color, (y * width + x) * 4);
}

/** A tile from a raw bitmap, with no bottom padding unless given. */
function tileOf(raw: RawImage, bottomPadding = 0): Tile {
	return { ...raw, bottomPadding };
}

/**
 * A small opaque tile, served as a `.tile` file for every card by default. With no bottom padding,
 * it triggers the clip warning whenever a row sits below it. The bytes are never modified: the
 * `readFile` spy hands out a fresh copy each time, as the real one does.
 */
const FIXTURE_RAW = solidRaw(TILE_WIDTH, TILE_HEIGHT, RED);
const FIXTURE_TILE = serializeTile(tileOf(FIXTURE_RAW));
/** The same art as a PNG, served by the CDN stub. `Response` copies its body. */
const FIXTURE_PNG = encodePng(
	toScanlines(FIXTURE_RAW.data, TILE_WIDTH, TILE_HEIGHT),
	TILE_WIDTH,
	TILE_HEIGHT
);

/** An opaque bitmap larger than a cell in both dimensions: CDN art bigger than any in `images/`. */
const OVERSIZED_WIDTH = CELL_WIDTH + 40;
const OVERSIZED_HEIGHT = CELL_HEIGHT + 60;
const BLUE: Rgba = [30, 120, 200, 255];

/** The gap between cells, derived from the plan so the test follows the renderer's constant. */
const COLUMN_GAP = (planGrid(1).width - 4 * CELL_WIDTH) / 3;

/** Where a tile of the given size lands on the canvas: centered and bottom-aligned in its cell. */
function placement(column: number, rowTop: number, width: number, height: number) {
	return {
		left: column * (CELL_WIDTH + COLUMN_GAP) + Math.floor((CELL_WIDTH - width) / 2),
		top: rowTop + CELL_HEIGHT - height,
	};
}

/** The RGBA values of one pixel in scanlines from `compositeScanlines`. */
function scanlinePixel(scanlines: Uint8Array, width: number, x: number, y: number) {
	const offset = y * (width * 4 + 1) + 1 + x * 4;
	return [...scanlines.subarray(offset, offset + 4)];
}

/** How many pixels of a decoded image have any alpha. */
function countVisible({ data }: RawImage) {
	let count = 0;
	for (let offset = 3; offset < data.length; offset += 4) {
		if (data[offset] !== 0) count++;
	}
	return count;
}

/**
 * Spies `Deno.readFile`, the renderer's source for local tiles, to serve `bytes` for every card.
 * Vitest runs inside Deno, so this replaces the real function. `restoreMocks` restores it before
 * each test, so the `beforeEach` below installs a new spy every time.
 */
function localTileReadFile(bytes: Uint8Array<ArrayBuffer>) {
	return vi
		.spyOn(Deno, "readFile")
		.mockImplementation(() => Promise.resolve(Uint8Array.from(bytes)));
}

/**
 * A `fetch` stub that serves `png`, standing in for the CDN. It is installed for every render test,
 * so a test can check that a render used no network at all. The fallback tests change its response
 * per test.
 */
function fetchServing(png: Uint8Array<ArrayBuffer>) {
	return vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
		Promise.resolve(new Response(png))
	);
}

let readFileMock: ReturnType<typeof localTileReadFile>;
let fetchMock: ReturnType<typeof fetchServing>;

/** Makes every local read fail with `NotFound`, so each card falls back to the CDN. */
function noLocalArt() {
	readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
}

/**
 * The dimensions of a rendered grid, found by decoding every pixel. A grid with a valid header but
 * a corrupt or truncated body fails here, where reading the header alone would pass.
 */
function dimensions(png: Uint8Array) {
	const { width, height } = decodePng(png);
	return { width, height };
}

describe("renderDeckGrid", () => {
	beforeEach(() => {
		readFileMock = localTileReadFile(FIXTURE_TILE);
		fetchMock = fetchServing(FIXTURE_PNG);
		vi.stubGlobal("fetch", fetchMock);
	});

	test("lays out a 4-column grid at the fixed cell resolution", async () => {
		const grid = dimensions(await renderDeckGrid(Array.from({ length: 8 }, () => card())));
		const singleRow = dimensions(await renderDeckGrid([card()]));

		// Cell size is fixed, so even this 20×30 fixture fills full-size cells, and a single card
		// still gets the full 4-column width.
		expect(singleRow).toEqual({ width: 1080, height: 405 });
		expect(grid).toEqual({ width: 1080, height: 794 });
		expect(grid).toEqual({ width: planGrid(8).width, height: planGrid(8).height });
	});

	test("places each tile centered and bottom-aligned in its cell, with transparency elsewhere", async () => {
		const marked = solidRaw(TILE_WIDTH, TILE_HEIGHT, RED);
		const corner: Rgba = [10, 20, 30, 255];
		paint(marked, 0, 0, corner);
		readFileMock.mockImplementation(() =>
			Promise.resolve(serializeTile(tileOf(marked, TILE_HEIGHT)))
		);

		const decoded = decodePng(await renderDeckGrid([card(), card()]));

		for (const column of [0, 1]) {
			const { left, top } = placement(column, 0, TILE_WIDTH, TILE_HEIGHT);

			// The marked corner proves the tile's first pixel landed at the computed origin, the far
			// corner that the tile reaches the cell's bottom row, and the neighbors that nothing
			// spilled past either edge.
			expect.soft(pixelAt(decoded, left, top)).toEqual(corner);
			expect.soft(pixelAt(decoded, left + TILE_WIDTH - 1, CELL_HEIGHT - 1)).toEqual(RED);
			expect.soft(pixelAt(decoded, left - 1, top)).toEqual(TRANSPARENT);
			expect.soft(pixelAt(decoded, left + TILE_WIDTH, top)).toEqual(TRANSPARENT);
			expect.soft(pixelAt(decoded, left, top - 1)).toEqual(TRANSPARENT);
		}

		// Two opaque tiles and nothing else.
		expect(countVisible(decoded)).toBe(2 * TILE_WIDTH * TILE_HEIGHT);
	});

	test("renders entirely from local tiles without touching the network", async () => {
		const cards = [card(), card(), card()];

		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Uint8Array);

		// One local read per card and no CDN request. A deck whose cards all have local tiles never
		// needs the network.
		expect(readFileMock).toHaveBeenCalledTimes(cards.length);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("reads the -evo.tile / -hero.tile / base variant per evolutionLevel", async () => {
		const evo = card({ evolutionLevel: 1 });
		const hero = card({ evolutionLevel: 2 });
		const base = card();

		await renderDeckGrid([evo, hero, base]);

		const paths = readFileMock.mock.calls.map((call) => String(call[0]));

		// Soft assertions: the three suffixes come from one table, so a mistake in it should report
		// every wrong file name in a single run.
		expect
			.soft(paths.some((path) => path.endsWith(`/tiles/${String(evo.id)}-evo.tile`)))
			.toBe(true);
		expect
			.soft(paths.some((path) => path.endsWith(`/tiles/${String(hero.id)}-hero.tile`)))
			.toBe(true);
		expect.soft(paths.some((path) => path.endsWith(`/tiles/${String(base.id)}.tile`))).toBe(true);
		// Local tiles are used whatever the evolution level, so there is no CDN request.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("falls back to the CDN icon when there is no local tile", async () => {
		noLocalArt();
		const missing = card({
			iconUrls: { medium: "https://api.clashroyale.com/fresh-release.png" },
		});

		await expect(renderDeckGrid([missing])).resolves.toBeInstanceOf(Uint8Array);

		// The request goes to the card's own icon URL, asks for PNG only since that is all the
		// decoder reads, and has a timeout signal attached.
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.clashroyale.com/fresh-release.png");
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "image/png" });
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("renders a CDN tile larger than the cell at the fixed grid size, without rejecting", async () => {
		noLocalArt();
		const oversized = encodePng(
			toScanlines(
				solidRaw(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, BLUE).data,
				OVERSIZED_WIDTH,
				OVERSIZED_HEIGHT
			),
			OVERSIZED_WIDTH,
			OVERSIZED_HEIGHT
		);
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(oversized)));

		// Without the shrink, the guard in `compositeScanlines` would reject the 301×465 tile. The
		// next test checks where the shrunk tile lands.
		await expect(renderDeckGrid([card()]).then((png) => dimensions(png))).resolves.toEqual({
			width: planGrid(1).width,
			height: planGrid(1).height,
		});
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("shrinking to fit"));
	});

	test("shrinks oversized CDN art to fit inside its cell", async () => {
		noLocalArt();
		const oversized = encodePng(
			toScanlines(
				solidRaw(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, BLUE).data,
				OVERSIZED_WIDTH,
				OVERSIZED_HEIGHT
			),
			OVERSIZED_WIDTH,
			OVERSIZED_HEIGHT
		);
		fetchMock.mockImplementation(() => Promise.resolve(new Response(oversized)));

		const decoded = decodePng(await renderDeckGrid([card()]));

		// Width is the binding dimension, so the shrunk tile spans the whole cell width and rests on
		// the cell's bottom row. Nothing lands right of the cell.
		expect.soft(pixelAt(decoded, 0, CELL_HEIGHT - 1)).toEqual(BLUE);
		expect.soft(pixelAt(decoded, CELL_WIDTH - 1, CELL_HEIGHT - 1)).toEqual(BLUE);
		expect.soft(pixelAt(decoded, CELL_WIDTH, CELL_HEIGHT - 1)).toEqual(TRANSPARENT);
		// The shrunk height is under the cell's, so the top row of the canvas stays transparent.
		expect.soft(pixelAt(decoded, 0, 0)).toEqual(TRANSPARENT);
		expect(countVisible(decoded)).toBeLessThanOrEqual(CELL_WIDTH * CELL_HEIGHT);
	});

	test("trims a CDN fallback icon before checking it against the cell, not after", async () => {
		noLocalArt();

		// A canvas larger than the cell with small art inside it, like a real 285×420 icon whose art
		// trims to within 261×405. Fitting the whole canvas into the cell would warn and shrink it.
		// Trimming first finds that the art already fits, so neither happens.
		const padded = solidRaw(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, TRANSPARENT);
		for (let y = 60; y < 60 + TILE_HEIGHT; y++) {
			for (let x = 40; x < 40 + TILE_WIDTH; x++) {
				paint(padded, x, y, RED);
			}
		}
		const paddedPng = encodePng(
			toScanlines(padded.data, OVERSIZED_WIDTH, OVERSIZED_HEIGHT),
			OVERSIZED_WIDTH,
			OVERSIZED_HEIGHT
		);
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(paddedPng)));

		await renderDeckGrid([
			card({ iconUrls: { medium: "https://api.clashroyale.com/padded.png" } }),
		]);

		expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("shrinking to fit"));
	});

	test("renders a palette CDN PNG", async () => {
		noLocalArt();
		// 2×1, indexed 8-bit: palette entry 0 then entry 1.
		const palettePng = buildPng({
			width: 2,
			height: 1,
			colorType: PALETTE,
			depth: 8,
			plte: [10, 20, 30, 40, 50, 60],
			samples: [0, 1],
		});
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(palettePng)));

		const decoded = decodePng(await renderDeckGrid([card()]));
		const { left, top } = placement(0, 0, 2, 1);

		expect(pixelAt(decoded, left, top)).toEqual([10, 20, 30, 255]);
		expect(pixelAt(decoded, left + 1, top)).toEqual([40, 50, 60, 255]);
	});

	test("renders a 16-bit CDN PNG", async () => {
		noLocalArt();
		// 1×1 RGBA at 16 bits per channel, big-endian; the high bytes are the 8-bit result.
		const deepPng = buildPng({
			width: 1,
			height: 1,
			colorType: RGBA,
			depth: 16,
			samples: [0x64, 0x01, 0xc8, 0x02, 0x32, 0x03, 0xff, 0xff],
		});
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(deepPng)));

		const decoded = decodePng(await renderDeckGrid([card()]));
		const { left, top } = placement(0, 0, 1, 1);

		expect(pixelAt(decoded, left, top)).toEqual([0x64, 0xc8, 0x32, 255]);
	});

	test("rejects without a CDN fallback when the local read fails for any reason but NotFound", async () => {
		const permissionError = new Deno.errors.PermissionDenied("EACCES");
		readFileMock.mockRejectedValue(permissionError);

		// Only `NotFound` means the card has no local tile yet. Any other read error, such as a
		// permission problem, propagates as it is, and no CDN request is made.
		await expect(renderDeckGrid([card()])).rejects.toBe(permissionError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("rejects without a CDN fallback when a local tile is corrupt", async () => {
		readFileMock.mockImplementation(() =>
			Promise.resolve(new TextEncoder().encode("not a tile file"))
		);

		await expect(renderDeckGrid([card()])).rejects.toThrow("STK1 magic");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("rejects a local tile larger than its cell", async () => {
		// `pnpm tiles` never writes one, but a stale or hand-edited file could. Copied unclipped, it
		// would run into the next row's filter byte and corrupt the PNG.
		const oversized = serializeTile(tileOf(solidRaw(CELL_WIDTH + 1, 10, RED)));
		readFileMock.mockImplementation(() => Promise.resolve(Uint8Array.from(oversized)));

		await expect(renderDeckGrid([card()])).rejects.toThrow("exceeds the 261x405 cell");
	});

	test("fetches the evolutionMedium/heroMedium icon variant when falling back for Evo/Hero cards", async () => {
		noLocalArt();

		await renderDeckGrid([
			card({
				evolutionLevel: 1,
				iconUrls: {
					medium: "https://api.clashroyale.com/evo-icon.png",
					evolutionMedium: "https://api.clashroyale.com/evo-variant.png",
				},
			}),
			card({
				evolutionLevel: 2,
				iconUrls: {
					medium: "https://api.clashroyale.com/hero-icon.png",
					heroMedium: "https://api.clashroyale.com/hero-variant.png",
				},
			}),
		]);

		const urls = fetchMock.mock.calls.map((call) => call[0]);

		// Soft assertions report all four checks together. The pattern of failures separates a wrong
		// icon key from a missing check.
		expect.soft(urls).toContain("https://api.clashroyale.com/evo-variant.png");
		expect.soft(urls).toContain("https://api.clashroyale.com/hero-variant.png");
		expect.soft(urls).not.toContain("https://api.clashroyale.com/evo-icon.png");
		expect.soft(urls).not.toContain("https://api.clashroyale.com/hero-icon.png");
	});

	test("rejects the render when an Evo/Hero card has no variant icon, without fetching medium", async () => {
		noLocalArt();

		// `medium` is the card's base art, the wrong picture for an Evolution or a Hero, so a missing
		// variant fails the render instead of fetching it.
		await expect(
			renderDeckGrid([
				card({
					evolutionLevel: 1,
					iconUrls: { medium: "https://api.clashroyale.com/no-variant.png" },
				}),
			])
		).rejects.toThrow("no evolutionMedium icon");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("rejects the render when the CDN fallback fetch fails", async () => {
		noLocalArt();
		fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid([card()])).rejects.toThrow("Card icon 500 for");
	});

	test("recovers on the next render after a failed fallback", async () => {
		const cards = [card()];

		// There is no local tile, so both renders use the CDN. The first request returns 500, and
		// every later one serves the fixture.
		noLocalArt();
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid(cards)).rejects.toThrow("Card icon 500 for");

		// A failed render must leave nothing behind that fails the next one. The no-cache test below
		// only renders successfully, so something that remembered failures, like a memoized rejected
		// promise, would pass it and fail here.
		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Uint8Array);
	});

	test("re-reads every tile when the same deck renders twice; there is no cache", async () => {
		const cards = [card(), card()];

		await renderDeckGrid(cards);

		expect(readFileMock).toHaveBeenCalledTimes(cards.length);

		await renderDeckGrid(cards);

		// The same deck again, so any render or tile cache would skip these reads. A different deck
		// would be read again with or without a cache, which is why this test repeats the deck.
		expect(readFileMock).toHaveBeenCalledTimes(cards.length * 2);
	});

	test("rejects an empty deck rather than encoding a zero-tile grid", async () => {
		// `discord.ts` passes `player.cards` without checking it, and an empty deck is a real case.
		// Without this check it would encode a blank strip; the rejection sends the post down the
		// text-only path instead.
		await expect(renderDeckGrid([])).rejects.toThrow("No cards to render");
		expect(readFileMock).not.toHaveBeenCalled();
	});

	test("warns that rows may clip when a tile keeps less bottom padding than the row overlap", async () => {
		// The fixture tile has no bottom padding, less than the 16 px the next row overlaps. Five
		// cards is the smallest deck with a second row, and only its first column has a tile below,
		// so only that column's upper tile warns.
		await renderDeckGrid(Array.from({ length: 5 }, () => card()));

		expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("grid rows may clip"));
	});

	test("stays quiet about clipping when the whole deck fits on one row", async () => {
		await renderDeckGrid(Array.from({ length: 4 }, () => card()));

		// No tile sits below any of them, so the check skips them. Otherwise these same tiles would
		// warn on every one-row grid.
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("compositeScanlines", () => {
	test("starts every scanline with filter byte 0, even when full-cell tiles fill the canvas", () => {
		// Full-cell tiles of 0xff bytes: a tile row that ran one byte too far, into the next row's
		// filter byte, would leave a nonzero byte at a row start.
		const full = tileOf(solidRaw(CELL_WIDTH, CELL_HEIGHT, [255, 255, 255, 255]));
		const plan = planGrid(8);
		const scanlines = compositeScanlines(
			Array.from({ length: 8 }, () => full),
			plan
		);
		const stride = plan.width * 4 + 1;

		const badRows = Array.from({ length: plan.height }, (_, y) => y).filter(
			(y) => scanlines[y * stride] !== 0
		);

		expect(scanlines.length).toBe(stride * plan.height);
		expect(badRows).toEqual([]);
	});

	describe("blends the lower row over the upper row in the overlap band", () => {
		// Two full-height tiles in column 0: the upper one opaque blue except one half-transparent
		// red pixel, the lower one transparent except four pixels in its top row, which lands inside
		// the upper tile's bottom 16 rows.
		const plan = planGrid(5);
		const lowerTop = placement(0, plan.rowTops[1] ?? 0, TILE_WIDTH, CELL_HEIGHT).top;
		const { left } = placement(0, 0, TILE_WIDTH, CELL_HEIGHT);

		const upper = solidRaw(TILE_WIDTH, CELL_HEIGHT, BLUE);
		const translucentUpper: Rgba = [200, 0, 0, 100];
		// The upper tile fills its cell from the canvas top, so its row index equals the canvas row.
		paint(upper, 3, lowerTop, translucentUpper);

		const lower = solidRaw(TILE_WIDTH, CELL_HEIGHT, TRANSPARENT);
		const opaque: Rgba = [255, 0, 0, 255];
		const half: Rgba = [0, 255, 0, 128];
		const halfOverHalf: Rgba = [0, 0, 200, 128];
		paint(lower, 0, 0, opaque);
		paint(lower, 1, 0, half);
		paint(lower, 3, 0, halfOverHalf);
		// Pixel 2 stays at alpha 0.

		const filler = tileOf(solidRaw(TILE_WIDTH, TILE_HEIGHT, RED), TILE_HEIGHT);
		const scanlines = compositeScanlines(
			[tileOf(upper), filler, filler, filler, tileOf(lower, 0)],
			plan
		);
		const at = (x: number) => scanlinePixel(scanlines, plan.width, left + x, lowerTop);

		/** Unpremultiplied source-over in floating point, the reference the integer math must match. */
		function sourceOver(src: Rgba, dst: Rgba): Rgba {
			const sa = src[3] / 255;
			const da = dst[3] / 255;
			const oa = sa + da * (1 - sa);
			const channel = (c: 0 | 1 | 2) => (src[c] * sa + dst[c] * da * (1 - sa)) / oa;
			return [channel(0), channel(1), channel(2), oa * 255];
		}

		/** The largest per-channel difference between a pixel and the reference. */
		function maxDifference(actual: number[], expected: Rgba) {
			return Math.max(...expected.map((value, i) => Math.abs((actual[i] ?? Number.NaN) - value)));
		}

		test("the lower tile's top row lands inside the upper tile", () => {
			expect(lowerTop).toBeLessThan(CELL_HEIGHT);
		});

		test("an opaque pixel overwrites the upper art", () => {
			expect(at(0)).toEqual(opaque);
		});

		test("a half-transparent pixel blends with unpremultiplied source-over", () => {
			expect.soft(maxDifference(at(1), sourceOver(half, BLUE))).toBeLessThanOrEqual(1);
			expect
				.soft(maxDifference(at(3), sourceOver(halfOverHalf, translucentUpper)))
				.toBeLessThanOrEqual(1);
		});

		test("a fully transparent pixel leaves the upper art untouched", () => {
			expect(at(2)).toEqual(BLUE);
		});
	});
});

describe("planGrid", () => {
	// Pure arithmetic with no pixels involved, so each test checks many tile counts.

	test("keeps four columns (constant width) regardless of tile count", () => {
		const widths = [1, 8, 16, 24].map((tileCount) => planGrid(tileCount).width);

		expect(new Set(widths).size).toBe(1);
	});

	test("adds one row per four tiles, rounding up", () => {
		for (const tileCount of [1, 4, 5, 8, 16, 24]) {
			expect(planGrid(tileCount).rowTops.length).toBe(Math.ceil(tileCount / 4));
		}
	});

	test("row tops strictly increase and are evenly spaced, so height grows linearly with row count", () => {
		for (const tileCount of [1, 4, 5, 8, 16, 24]) {
			const { rowTops } = planGrid(tileCount);
			const pitches = rowTops.slice(1).map((top, i) => top - (rowTops[i] ?? 0));

			// Every step from one row top to the next is the same positive distance.
			expect(new Set(pitches).size).toBeLessThanOrEqual(1);
			for (const pitch of pitches) {
				expect(pitch).toBeGreaterThan(0);
			}
		}
	});
});
