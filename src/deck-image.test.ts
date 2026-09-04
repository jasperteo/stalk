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

// A monotonic counter hands each `card()` call its own id, so decks built in different tests stay
// distinguishable. Tests that render the same deck twice build the array once and reuse it.
let nextId = 1;

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

/** A fully-opaque solid-color PNG of the given size, the base shape of every fixture below. */
async function solidPng(width: number, height: number, color: { r: number; g: number; b: number }) {
	return await sharp({
		create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
	})
		.png()
		.toBuffer();
}

/**
 * Whatever `toBuffer()` resolves to, carried through rather than restated: a bare `Buffer`
 * annotation widens to `Buffer<ArrayBufferLike>`, which `Response`'s `BodyInit` will not accept.
 */
type Fixture = Awaited<ReturnType<typeof solidPng>>;

/** Encodes a raw straight-alpha RGBA buffer to PNG. */
async function rawToPng(raw: Buffer, width: number, height: number) {
	return await sharp(raw, { raw: { width, height, channels: 4 } })
		.png()
		.toBuffer();
}

/**
 * A small, fully-opaque solid-color PNG, encoded once for the whole file. It has no transparent
 * margin, so `trimToArt` keeps it at full size and its geometry is predictable. Nothing mutates the
 * bytes. The `readFile` mock hands out a fresh `Uint8Array` copy, as the real one would, and
 * `Response` snapshots its body, so both the local-mirror read and the CDN fallback can serve it.
 *
 * `Lazy` rather than a top-level `await`, which encoded it during collection on every run: only the
 * `renderDeckGrid` block needs it, so `vitest -t planGrid` or `-t trimToArt` now skips the encode
 * entirely. Same reason `deck-image.ts` wraps sharp itself.
 */
const FIXTURE = new Lazy(() => solidPng(TILE_WIDTH, TILE_HEIGHT, { r: 200, g: 30, b: 30 }));

/**
 * A raw straight-alpha RGBA canvas (`width`×`height`, fully transparent) with an opaque solid-color
 * rectangle painted at `rect`, encoded to PNG. Unlike `FIXTURE` (fully opaque, so `trimToArt` never
 * actually crops it), this exercises a real crop: the transparent margin around `rect` gives
 * `scanArtBounds`/`cropRaw` a genuine region to derive, with bounds the caller controls by
 * construction (`rect`'s own coordinates), rather than needing to reverse-engineer them from a real
 * card icon.
 */
type Mark = { x: number; y: number; color: [r: number, g: number, b: number] };

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

	// Painted last, so a mark inside `rect` overwrites the fill. The fill is one flat color, which
	// makes every pixel in it interchangeable — a crop landing at the wrong offset returns the same
	// bytes as a correct one. Marks are what give the canvas distinguishable positions.
	for (const { x, y, color } of marks) {
		const offset = (y * width + x) * 4;
		[raw[offset], raw[offset + 1], raw[offset + 2]] = color;
		raw[offset + 3] = 255;
	}

	return await rawToPng(raw, width, height);
}

/** One pixel's RGBA out of a decoded tile, for asserting _where_ cropped bytes came from. */
function pixelAt({ data, width }: { data: Buffer; width: number }, x: number, y: number) {
	const offset = (y * width + x) * 4;
	return [...data.subarray(offset, offset + 4)];
}

/**
 * A fully-opaque solid-color PNG bigger than the compose cell (`CELL_WIDTH`×`CELL_HEIGHT`) in both
 * dimensions, standing in for a brand-new card whose CDN art hasn't been downsized to the local
 * mirror's convention.
 */
const OVERSIZED_WIDTH = CELL_WIDTH + 40;
const OVERSIZED_HEIGHT = CELL_HEIGHT + 60;
const OVERSIZED_FIXTURE = new Lazy(() =>
	solidPng(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, { r: 30, g: 120, b: 200 })
);

/**
 * Spies `Deno.readFile`, the module's primary tile source (the local `images/` mirror), to serve
 * the fixture for every card. Same pattern as main.test.ts spying `Deno.openKv`/`Deno.cron`: vitest
 * runs inside Deno, so `Deno` is the real ambient global. `restoreMocks` puts the genuine
 * `readFile` back before each test, so each `beforeEach` installs a fresh spy.
 */
function localArtReadFile(fixture: Fixture) {
	return vi
		.spyOn(Deno, "readFile")
		.mockImplementation(() => Promise.resolve(new Uint8Array(fixture)));
}

/**
 * The CDN fallback source, stubbed onto global `fetch`. It only runs for a card missing from the
 * local mirror; installing it by default (serving the fixture) means tests can assert it is NOT
 * called for a fully-local render, and the fallback tests override it per-case.
 */
function fetchServingFixture(fixture: Fixture) {
	return vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
		Promise.resolve(new Response(fixture))
	);
}

let readFileMock: ReturnType<typeof localArtReadFile>;
let fetchMock: ReturnType<typeof fetchServingFixture>;

/**
 * Fully decodes a rendered grid through the renderer's own `decodeToRaw`, so these assertions cover
 * the whole pixel stream: a grid whose PNG header is valid but whose body is corrupt or truncated
 * fails here rather than passing a header-only check.
 */
async function dimensions(png: Uint8Array) {
	const { width, height } = await decodeToRaw(png);
	return { width, height };
}

describe("renderDeckGrid", () => {
	// Scoped to this block rather than the file: planGrid is pure geometry and trimToArt encodes its
	// own inputs, so neither needs these stubs, and a file-scoped hook would force FIXTURE's encode
	// for them anyway.
	beforeEach(async () => {
		const fixture = await FIXTURE.get();

		readFileMock = localArtReadFile(fixture);
		fetchMock = fetchServingFixture(fixture);
		vi.stubGlobal("fetch", fetchMock);
	});

	test("lays out a 4-column grid at the fixed cell resolution", async () => {
		const eightCards = Array.from({ length: 8 }, () => card());

		// Nothing shared between the two renders (distinct ids), so they can run concurrently. This is
		// the suite's most expensive test (9 tile decode round-trips).
		const [grid, singleRow] = await Promise.all([
			renderDeckGrid(eightCards).then((png) => dimensions(png)),
			renderDeckGrid([card()]).then((png) => dimensions(png)),
		]);

		// Cell size is fixed (CELL_WIDTH/CELL_HEIGHT), not derived from the tiles in the deck, so even
		// this small fixture (well under either dimension) composites into a full-size row, and a lone
		// card still reserves the full 4-column width with trailing cells empty. Compose happens at
		// native resolution with no downscale before encode, so the shipped dimensions equal
		// `planGrid`'s.
		expect(singleRow.height).toBe(planGrid(1).height);
		expect(singleRow.width).toBe(planGrid(1).width);
		// The full deck spans the same 4 columns and adds a second row. Asserted relative to the
		// single-row render rather than against COLUMN_GAP/ROW_GAP, which are tuning knobs.
		expect(grid.width).toBe(singleRow.width);
		expect(grid.height).toBeGreaterThan(singleRow.height);
	});

	test("renders entirely from the local mirror without touching the network", async () => {
		const cards = [card(), card(), card()];

		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Buffer);

		// One local read per card and no CDN fallback. The mirror is meant to cover every playable
		// card, so a fully-local deck must never hit the network.
		expect(readFileMock).toHaveBeenCalledTimes(cards.length);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("reads the -evo.png / -hero.png / base variant per evolutionLevel", async () => {
		const evo = card({ evolutionLevel: 1 });
		const hero = card({ evolutionLevel: 2 });
		const base = card();

		await renderDeckGrid([evo, hero, base]);

		const paths = readFileMock.mock.calls.map((call) => String(call[0]));

		// Soft: one suffix table drives all three, so a broken mapping should report every wrong
		// filename in one run rather than one per re-run.
		expect.soft(paths.some((path) => path.endsWith(`${String(evo.id)}-evo.png`))).toBe(true);
		expect.soft(paths.some((path) => path.endsWith(`${String(hero.id)}-hero.png`))).toBe(true);
		expect.soft(paths.some((path) => path.endsWith(`${String(base.id)}.png`))).toBe(true);
		// No network for locally-mirrored cards, whatever their evolutionLevel.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("falls back to the CDN icon when the local mirror has no art", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		const missing = card({
			iconUrls: { medium: "https://api.clashroyale.com/fresh-release.png" },
		});

		await expect(renderDeckGrid([missing])).resolves.toBeInstanceOf(Buffer);

		// The fallback fetches the card's own icon URL, with the render's abort signal attached.
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

		// Deliberately not named as a test of the clamp: the grid's dimensions are fixed by
		// CELL_WIDTH/CELL_HEIGHT regardless of tile content, so they would match here with or without
		// it. What this does catch is the oversized path *rejecting* — an unclamped tile drives the
		// overlay offsets negative (see renderDeckGrid) and sharp refuses the composite. The clamp's
		// actual behavior is covered by the trim-before-fit test below and by `describe("trimToArt")`.
		// Compared against planGrid rather than a second live render, which cost a full extra decode
		// round-trip to restate a constant.
		const { width, height } = planGrid(1);

		await expect(dimensions(await renderDeckGrid([oversized]))).resolves.toEqual({ width, height });
	});

	test("trims a CDN fallback icon before checking it against the cell, not after", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

		// A canvas bigger than the cell (like OVERSIZED_FIXTURE) but padded around art small enough to
		// need no scaling at all. This mirrors the local mirror's 285x420 frame around art that's well
		// under the 261x405 cell once trimmed. Fitting the raw canvas to the cell first (the bug)
		// would still warn and shrink; trimming first should do neither.
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

		// Only Deno.errors.NotFound means "not mirrored yet, try the CDN". Any other read failure
		// (permissions, a corrupt mount, ...) must propagate as-is, with no fallback fetch attempted.
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

		// Soft: the pair of "took the variant" and "left medium alone" facts is one behavior per level,
		// and seeing all four at once tells a wrong-key bug from a missing-guard bug immediately.
		expect.soft(urls).toContain("https://api.clashroyale.com/evo-variant.png");
		expect.soft(urls).toContain("https://api.clashroyale.com/hero-variant.png");
		expect.soft(urls).not.toContain("https://api.clashroyale.com/evo-icon.png");
		expect.soft(urls).not.toContain("https://api.clashroyale.com/hero-icon.png");
	});

	test("rejects the render when an Evo/Hero card has no variant icon, without fetching medium", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

		// medium is the card's un-evolved art. That's the wrong picture for an Evolution/Hero, so a
		// missing variant must fail the render rather than silently fetch it.
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

		// Local art is missing throughout, so both renders take the CDN fallback; the first fetch 500s
		// and every later one serves the fixture.
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid(cards)).rejects.toThrow("Card icon 500 for");

		// No module-level state outlives a call, so a failed render has no lasting side effect: the
		// retry is just another independent render. Distinct from the no-cache test below, which only
		// covers renders that succeed: a cache that remembered *failures* alone would pass that one and
		// fail this one. That is the exact regression `sharpModule`'s `Lazy` exists to prevent, so the
		// suite keeps a test for it at the renderDeckGrid level too.
		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Buffer);
	});

	test("re-reads every tile when the same deck renders twice; there is no cache", async () => {
		const cards = [card(), card()];

		await renderDeckGrid(cards);

		expect(readFileMock).toHaveBeenCalledTimes(cards.length);

		await renderDeckGrid(cards);

		// The *identical* deck, rendered again: a cold start per tick means a cross-tick cache
		// could never hit, so renderDeckGrid deliberately keeps none, and no per-tile cache either
		// (local reads ride the OS page cache). Re-rendering a different deck would pass either way,
		// so this only pins the decision when the decks match.
		expect(readFileMock).toHaveBeenCalledTimes(cards.length * 2);
	});

	test("rejects an empty deck rather than encoding a zero-tile grid", async () => {
		// discord.ts hands over `player.cards` unchecked, and planGrid(0) would still describe a
		// 4-column canvas. The guard is what turns an empty deck into the text-only fallback.
		await expect(renderDeckGrid([])).rejects.toThrow("No cards to render");
		expect(readFileMock).not.toHaveBeenCalled();
	});

	test("warns that rows may clip when a tile keeps less bottom padding than the row overlap", async () => {
		// FIXTURE is fully opaque, so trimToArt keeps it to the pixel: bottomPadding 0, under the 16px
		// the row below overlaps by (ROW_GAP). Five tiles is the smallest deck with a row under another.
		await renderDeckGrid(Array.from({ length: 5 }, () => card()));

		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("grid rows may clip"));
	});

	test("stays quiet about clipping when the whole deck fits on one row", async () => {
		await renderDeckGrid(Array.from({ length: 4 }, () => card()));

		// Nothing sits below the last row to clip into it, so the check has to skip that row.
		// Otherwise the same zero-padding tiles would warn on every single-row post.
		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("planGrid", () => {
	// Pure geometry, no sharp. Cheap enough to check across many tile counts at once.

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

			// Every gap between consecutive row tops is the same pitch, with no wider gap at any
			// point. That's what a block-boundary divider used to introduce.
			expect(new Set(pitches).size).toBeLessThanOrEqual(1);
			for (const pitch of pitches) {
				expect(pitch).toBeGreaterThan(0);
			}
		}
	});
});

describe("trimToArt", () => {
	// A 30×40 canvas with an opaque rect whose right edge lands exactly on the canvas's own
	// right edge (left + width === canvas width). This is the boundary `cropRaw`'s bounds guard
	// has to accept rather than reject. `trimToArt` always keeps the native bottom edge (see its
	// own doc comment), so the crop's bottom always reaches the canvas height regardless of the
	// rect's own bottom; only left/top/right are meaningfully "trimmed" here.
	const CANVAS_WIDTH = 30;
	const CANVAS_HEIGHT = 40;
	const RECT = { left: 5, top: 8, width: CANVAS_WIDTH - 5, height: 20 };

	// Two positional markers, both outside `RECT`'s flat fill in the ways that matter. `ORIGIN` sits
	// on the crop's own top-left corner and `LAST_ROW` on its final row; neither moves the bounds
	// `scanArtBounds` derives (ORIGIN is already the rect's corner, and LAST_ROW shares its x and
	// lies below, while trimToArt keeps the native bottom edge regardless).
	const ORIGIN: Mark = { x: RECT.left, y: RECT.top, color: [10, 20, 30] };
	const LAST_ROW: Mark = { x: RECT.left, y: CANVAS_HEIGHT - 1, color: [40, 50, 60] };

	test("crops the art's own region, byte for byte, when it touches the right edge of the frame", async () => {
		const bytes = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT, [ORIGIN, LAST_ROW]);

		const tile = await trimToArt(bytes);

		// left trims to the rect's own left; width extends to the canvas's right edge (RECT was built
		// to touch it); height always runs from the rect's top down to the native bottom.
		expect(tile.width).toBe(CANVAS_WIDTH - RECT.left);
		expect(tile.height).toBe(CANVAS_HEIGHT - RECT.top);
		expect(tile.data.length).toBe(tile.width * tile.height * 4);

		// Shape alone cannot see `cropRaw`'s copy loop at all: `Buffer.alloc` sizes the destination
		// before the loop runs, so a loop that skips a row, or reads from the wrong offset, still
		// yields exactly these dimensions. These two pixels are what pin the bytes. The first fails if
		// the row start drops `region.left` or `region.top` (both read a transparent pixel instead);
		// the second fails if the loop stops a row short, leaving alloc's zero-fill behind.
		expect(pixelAt(tile, 0, 0)).toEqual([...ORIGIN.color, 255]);
		expect(pixelAt(tile, 0, tile.height - 1)).toEqual([...LAST_ROW.color, 255]);
	});

	test("keeps the whole frame for a fully transparent tile", async () => {
		// scanArtBounds returns `undefined` here. Shouldn't happen for real card art, but the fallback
		// has to be the untouched frame: cropping to an empty region would hand `.composite()` a
		// zero-byte input and reject the whole render over one blank tile.
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
		// Every row counts as padding, so a blank tile also trips renderDeckGrid's clip warning.
		expect(tile.bottomPadding).toBe(CANVAS_HEIGHT);
	});
});
