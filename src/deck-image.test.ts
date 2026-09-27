/**
 * @module
 *
 * Tests for `deck-image.ts`, with real sharp and generated PNG fixtures instead of real card art.
 * `Deno.readFile` is spied to serve the local art, and `fetch` is stubbed to serve the CDN
 * fallback, so no test reads `images/` or touches the network.
 *
 * Most fixtures are fully opaque, so trimming keeps them whole. `describe("trimToArt")` builds
 * fixtures with transparent margins to test a real crop. None of this checks real card art; after a
 * change to trimming or cropping, render the sample deck with `pnpm preview` and look at it.
 */

import { Buffer } from "node:buffer";

import { Lazy } from "@std/async/lazy";
import sharp from "sharp";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	CELL_HEIGHT,
	CELL_WIDTH,
	decodeToRaw,
	planGrid,
	renderDeckGrid,
	trimToArt,
} from "@/deck-image.ts";
import { log } from "@/log.ts";
import type { Card } from "@/schema.ts";

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

const TILE_WIDTH = 20;
const TILE_HEIGHT = 30;

/** A fully opaque PNG of one color. Every fixture in this file starts from one. */
async function solidPng(width: number, height: number, color: { r: number; g: number; b: number }) {
	return await sharp({
		create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
	})
		.png()
		.toBuffer();
}

/**
 * The type `toBuffer()` resolves to, taken from {@link solidPng}. Writing `Buffer` instead would
 * mean `Buffer<ArrayBufferLike>`, which `Response` does not accept as a body.
 */
type Fixture = Awaited<ReturnType<typeof solidPng>>;

/** Encodes raw RGBA pixels, with unpremultiplied alpha, as a PNG. */
async function rawToPng(raw: Buffer, width: number, height: number) {
	return await sharp(raw, { raw: { width, height, channels: 4 } })
		.png()
		.toBuffer();
}

/**
 * A small opaque PNG, encoded once and served for every card by default. With no transparent
 * margin, trimming keeps it whole, so its size in the grid is known. The bytes are never modified:
 * the `readFile` spy hands out a fresh copy each time, as the real one does, and `Response` copies
 * its body, so the local read and the CDN fallback can both serve it.
 *
 * It is a `Lazy` so that only the tests that use it pay for the encode. A top-level `await` would
 * encode it while Vitest collects the file, even for a run filtered to `planGrid` or `trimToArt`.
 */
const FIXTURE = new Lazy(() => solidPng(TILE_WIDTH, TILE_HEIGHT, { r: 200, g: 30, b: 30 }));

/**
 * A pixel painted in its own color, so a test can tell where cropped bytes came from. The fill of
 * an {@link insetFixture} is one flat color, so without marks a crop taken at the wrong offset would
 * return the same bytes as the right one.
 */
type Mark = { x: number; y: number; color: [r: number, g: number, b: number] };

/**
 * A transparent `width`×`height` PNG with an opaque rectangle at `rect` and optional marked pixels.
 * The transparent margin around `rect` gives `scanArtBounds` and `cropRaw` a real crop to make, and
 * the test knows the expected bounds because it chose `rect`.
 */
async function insetFixture(
	width: number,
	height: number,
	rect: { left: number; top: number; width: number; height: number },
	marks: Mark[] = []
) {
	const raw = Buffer.alloc(width * height * 4);

	for (let y = rect.top; y < rect.top + rect.height; y++) {
		for (let x = rect.left; x < rect.left + rect.width; x++) {
			const offset = (y * width + x) * 4;
			raw[offset] = 200;
			raw[offset + 1] = 30;
			raw[offset + 2] = 30;
			raw[offset + 3] = 255;
		}
	}

	// Marks are painted after the fill, so a mark inside `rect` replaces the fill color.
	for (const { x, y, color } of marks) {
		const offset = (y * width + x) * 4;
		[raw[offset], raw[offset + 1], raw[offset + 2]] = color;
		raw[offset + 3] = 255;
	}

	return await rawToPng(raw, width, height);
}

/** The RGBA values of one pixel in a tile, for checking where cropped bytes came from. */
function pixelAt({ data, width }: { data: Buffer; width: number }, x: number, y: number) {
	const offset = (y * width + x) * 4;
	return [...data.subarray(offset, offset + 4)];
}

/**
 * An opaque PNG larger than a cell in both dimensions: art from the CDN for a card bigger than any
 * in `images/`. {@link OVERSIZED_FIXTURE} is its lazily encoded PNG.
 */
const OVERSIZED_WIDTH = CELL_WIDTH + 40;
const OVERSIZED_HEIGHT = CELL_HEIGHT + 60;
const OVERSIZED_FIXTURE = new Lazy(() =>
	solidPng(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, { r: 30, g: 120, b: 200 })
);

/**
 * Spies `Deno.readFile`, the renderer's source for local art, to serve `fixture` for every card.
 * Vitest runs inside Deno, so this replaces the real function. `restoreMocks` restores it before
 * each test, so the `beforeEach` below installs a new spy every time.
 */
function localArtReadFile(fixture: Fixture) {
	return vi
		.spyOn(Deno, "readFile")
		.mockImplementation(() => Promise.resolve(new Uint8Array(fixture)));
}

/**
 * A `fetch` stub that serves `fixture`, standing in for the CDN. It is installed for every render
 * test, so a test can check that a render used no network at all. The fallback tests change its
 * response per test.
 */
function fetchServingFixture(fixture: Fixture) {
	return vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
		Promise.resolve(new Response(fixture))
	);
}

let readFileMock: ReturnType<typeof localArtReadFile>;
let fetchMock: ReturnType<typeof fetchServingFixture>;

/**
 * The dimensions of a rendered grid, found by decoding every pixel with the renderer's own
 * `decodeToRaw`. A grid with a valid header but a corrupt or truncated body fails here, where
 * reading the header alone would pass.
 */
async function dimensions(png: Uint8Array) {
	const { width, height } = await decodeToRaw(png);
	return { width, height };
}

describe("renderDeckGrid", () => {
	// Only this block needs the stubs. `planGrid` touches no pixels and the `trimToArt` tests encode
	// their own input, so a file-wide hook would encode FIXTURE for them for nothing.
	beforeEach(async () => {
		const fixture = await FIXTURE.get();

		readFileMock = localArtReadFile(fixture);
		fetchMock = fetchServingFixture(fixture);
		vi.stubGlobal("fetch", fetchMock);
	});

	test("lays out a 4-column grid at the fixed cell resolution", async () => {
		const eightCards = Array.from({ length: 8 }, () => card());

		// The two renders share no cards, so they run concurrently. They decode 9 tiles between them,
		// which makes this the slowest test in the file.
		const [grid, singleRow] = await Promise.all([
			renderDeckGrid(eightCards).then((png) => dimensions(png)),
			renderDeckGrid([card()]).then((png) => dimensions(png)),
		]);

		// Cell size is fixed, so even this 20×30 fixture fills full-size cells, and a single card
		// still gets the full 4-column width. The grid is encoded at its layout size, so the decoded
		// dimensions equal `planGrid`'s.
		expect(singleRow.height).toBe(planGrid(1).height);
		expect(singleRow.width).toBe(planGrid(1).width);
		// A full deck has the same width and a second row. Comparing it with the single-row render,
		// not with the gap constants, keeps the test valid when the gaps are tuned.
		expect(grid.width).toBe(singleRow.width);
		expect(grid.height).toBeGreaterThan(singleRow.height);
	});

	test("renders entirely from the local mirror without touching the network", async () => {
		const cards = [card(), card(), card()];

		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Buffer);

		// One local read per card and no CDN request. A deck whose cards all have local art never
		// needs the network.
		expect(readFileMock).toHaveBeenCalledTimes(cards.length);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("reads the -evo.png / -hero.png / base variant per evolutionLevel", async () => {
		const evo = card({ evolutionLevel: 1 });
		const hero = card({ evolutionLevel: 2 });
		const base = card();

		await renderDeckGrid([evo, hero, base]);

		const paths = readFileMock.mock.calls.map((call) => String(call[0]));

		// Soft assertions: the three suffixes come from one table, so a mistake in it should report
		// every wrong file name in a single run.
		expect.soft(paths.some((path) => path.endsWith(`${String(evo.id)}-evo.png`))).toBe(true);
		expect.soft(paths.some((path) => path.endsWith(`${String(hero.id)}-hero.png`))).toBe(true);
		expect.soft(paths.some((path) => path.endsWith(`${String(base.id)}.png`))).toBe(true);
		// Local art is used whatever the evolution level, so there is no CDN request.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("falls back to the CDN icon when the local mirror has no art", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		const missing = card({
			iconUrls: { medium: "https://api.clashroyale.com/fresh-release.png" },
		});

		await expect(renderDeckGrid([missing])).resolves.toBeInstanceOf(Buffer);

		// The request goes to the card's own icon URL, with a timeout signal attached.
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.clashroyale.com/fresh-release.png");
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "image/*" });
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("renders a CDN tile larger than the cell at the fixed grid size, without rejecting", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		const oversizedBytes = await OVERSIZED_FIXTURE.get();
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(oversizedBytes)));

		const oversized = card({
			iconUrls: { medium: "https://api.clashroyale.com/oversized.png" },
		});

		// The grid's size comes from the cell constants, so matching it proves little about the
		// shrink itself. What this test catches is a rejection: without the shrink, the 465 px tile
		// would be taller than the 405 px one-row canvas, and sharp rejects an overlay larger than the
		// image it goes onto. The shrink's result is covered by the next test and by
		// `describe("trimToArt")`.
		const { width, height } = planGrid(1);

		await expect(dimensions(await renderDeckGrid([oversized]))).resolves.toEqual({ width, height });
	});

	test("trims a CDN fallback icon before checking it against the cell, not after", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

		// A canvas larger than the cell with small art inside it, like a real 285×420 icon whose art
		// trims to within 261×405. Fitting the whole canvas into the cell would warn and shrink it.
		// Trimming first finds that the art already fits, so neither happens.
		const padded = await insetFixture(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, {
			left: 40,
			top: 60,
			width: TILE_WIDTH,
			height: TILE_HEIGHT,
		});
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(padded)));

		await renderDeckGrid([
			card({ iconUrls: { medium: "https://api.clashroyale.com/padded.png" } }),
		]);

		expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("shrinking to fit"));
	});

	test("rejects without a CDN fallback when the local read fails for any reason but NotFound", async () => {
		const permissionError = new Deno.errors.PermissionDenied("EACCES");
		readFileMock.mockRejectedValue(permissionError);

		// Only `NotFound` means the card has no local art yet. Any other read error, such as a
		// permission problem, propagates as it is, and no CDN request is made.
		await expect(renderDeckGrid([card()])).rejects.toBe(permissionError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("fetches the evolutionMedium/heroMedium icon variant when falling back for Evo/Hero cards", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

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
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

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
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid([card()])).rejects.toThrow("Card icon 500 for");
	});

	test("recovers on the next render after a failed fallback", async () => {
		const cards = [card()];

		// There is no local art, so both renders use the CDN. The first request returns 500, and every
		// later one serves the fixture.
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid(cards)).rejects.toThrow("Card icon 500 for");

		// A failed render must leave nothing behind that fails the next one. The no-cache test below
		// only renders successfully, so something that remembered failures, like a memoized rejected
		// promise, would pass it and fail here.
		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Buffer);
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
		// FIXTURE is fully opaque, so its tile has no bottom padding, less than the 16 px the next row
		// overlaps. Five cards is the smallest deck with a second row.
		await renderDeckGrid(Array.from({ length: 5 }, () => card()));

		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("grid rows may clip"));
	});

	test("stays quiet about clipping when the whole deck fits on one row", async () => {
		await renderDeckGrid(Array.from({ length: 4 }, () => card()));

		// No row sits below the last one, so the check skips it. Otherwise these same tiles would warn
		// on every one-row grid.
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("planGrid", () => {
	// Pure arithmetic with no sharp involved, so each test checks many tile counts.

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

describe("trimToArt", () => {
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

	test("crops the art's own region, byte for byte, when it touches the right edge of the frame", async () => {
		const bytes = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT, [ORIGIN, LAST_ROW]);

		const tile = await trimToArt(bytes);

		// The left edge moves in to the rectangle, the right edge stays at the canvas edge, and the
		// height runs from the rectangle's top to the bottom of the canvas.
		expect(tile.width).toBe(CANVAS_WIDTH - RECT.left);
		expect(tile.height).toBe(CANVAS_HEIGHT - RECT.top);
		expect(tile.data.length).toBe(tile.width * tile.height * 4);

		// The size checks cannot see `cropRaw`'s copy loop, because `Buffer.alloc` sizes the output
		// before the loop runs. These two pixels check the bytes. The first fails if the copy
		// ignores `region.left` or `region.top`, since it would read a transparent pixel. The second
		// fails if the loop stops a row early, leaving zeros from `Buffer.alloc`.
		expect(pixelAt(tile, 0, 0)).toEqual([...ORIGIN.color, 255]);
		expect(pixelAt(tile, 0, tile.height - 1)).toEqual([...LAST_ROW.color, 255]);
	});

	test("keeps the whole frame for a fully transparent tile", async () => {
		// `scanArtBounds` returns `undefined` for a blank image. Real card art is never blank, but
		// the tile must still be the whole frame: an empty crop would give `.composite()` a zero-byte
		// input and fail the render.
		const blank = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, {
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		});

		const tile = await trimToArt(blank);

		expect(tile.width).toBe(CANVAS_WIDTH);
		expect(tile.height).toBe(CANVAS_HEIGHT);
		expect(tile.data.length).toBe(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
		// Every row counts as padding, so a blank tile never triggers the clip warning.
		expect(tile.bottomPadding).toBe(CANVAS_HEIGHT);
	});
});
