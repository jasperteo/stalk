import { Buffer } from "node:buffer";

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
 */
const FIXTURE = await solidPng(TILE_WIDTH, TILE_HEIGHT, { r: 200, g: 30, b: 30 });

/**
 * A raw straight-alpha RGBA canvas (`width`×`height`, fully transparent) with an opaque solid-color
 * rectangle painted at `rect`, encoded to PNG. Unlike `FIXTURE` (fully opaque, so `trimToArt` never
 * actually crops it), this exercises a real crop: the transparent margin around `rect` gives
 * `scanArtBounds`/`cropRaw` a genuine region to derive, with bounds the caller controls by
 * construction (`rect`'s own coordinates), rather than needing to reverse-engineer them from a real
 * card icon.
 */
async function insetFixture(
	width: number,
	height: number,
	rect: { left: number; top: number; width: number; height: number }
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

	return await rawToPng(raw, width, height);
}

/**
 * A fully-opaque solid-color PNG bigger than the compose cell (`CELL_WIDTH`×`CELL_HEIGHT`) in both
 * dimensions, standing in for a brand-new card whose CDN art hasn't been downsized to the local
 * mirror's convention.
 */
const OVERSIZED_WIDTH = CELL_WIDTH + 40;
const OVERSIZED_HEIGHT = CELL_HEIGHT + 60;
const OVERSIZED_FIXTURE = await solidPng(OVERSIZED_WIDTH, OVERSIZED_HEIGHT, {
	r: 30,
	g: 120,
	b: 200,
});

/**
 * Spies `Deno.readFile`, the module's primary tile source (the local `images/` mirror), to serve
 * the fixture for every card. Same pattern as main.test.ts spying `Deno.openKv`/`Deno.cron`: vitest
 * runs inside Deno, so `Deno` is the real ambient global. `restoreMocks` puts the genuine
 * `readFile` back before each test, so each `beforeEach` installs a fresh spy.
 */
function localArtReadFile() {
	return vi
		.spyOn(Deno, "readFile")
		.mockImplementation(() => Promise.resolve(new Uint8Array(FIXTURE)));
}

/**
 * The CDN fallback source, stubbed onto global `fetch`. It only runs for a card missing from the
 * local mirror; installing it by default (serving the fixture) means tests can assert it is NOT
 * called for a fully-local render, and the fallback tests override it per-case.
 */
function fetchServingFixture() {
	return vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
		Promise.resolve(new Response(FIXTURE))
	);
}

let readFileMock: ReturnType<typeof localArtReadFile>;
let fetchMock: ReturnType<typeof fetchServingFixture>;

beforeEach(() => {
	readFileMock = localArtReadFile();
	fetchMock = fetchServingFixture();
	vi.stubGlobal("fetch", fetchMock);
});

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
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("clamps an oversized CDN fallback tile to the cell instead of composing it past the cell bounds", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(OVERSIZED_FIXTURE)));

		const oversized = card({
			iconUrls: { medium: "https://api.clashroyale.com/oversized.png" },
		});
		const [oversizedPng, normalPng] = await Promise.all([
			renderDeckGrid([oversized]),
			renderDeckGrid([card()]),
		]);

		// The grid's own dimensions are fixed by CELL_WIDTH/CELL_HEIGHT regardless of tile content, so
		// an unclamped oversized tile wouldn't change them either. What the clamp actually prevents is
		// the tile's overlay offsets going negative (see renderDeckGrid) and the source being visibly
		// sliced. A successful render at the expected fixed size is the observable proxy available
		// from outside the module: `fit: "inside"` means a tile that already exceeds the cell now
		// decodes into a rectangle bounded by CELL_WIDTH×CELL_HEIGHT, which trimToArt (also exercised
		// directly below) confirms in isolation.
		await expect(dimensions(oversizedPng)).resolves.toEqual(await dimensions(normalPng));
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
		// retry is just another independent render.
		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Buffer);
	});

	test("re-reads every tile when the same deck renders twice; there is no cache", async () => {
		const cards = [card(), card()];

		await renderDeckGrid(cards);

		expect(readFileMock).toHaveBeenCalledTimes(cards.length);

		await renderDeckGrid(cards);

		// The *identical* deck, rendered again: a fresh isolate per tick means a cross-tick cache
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

	test("crops without throwing when the art touches the right edge of the frame, and the buffer is exactly width*height*4", async () => {
		const bytes = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT);

		const tile = await trimToArt(bytes);

		// left trims to the rect's own left; width extends to the canvas's right edge (RECT was built
		// to touch it); height always runs from the rect's top down to the native bottom.
		expect(tile.width).toBe(CANVAS_WIDTH - RECT.left);
		expect(tile.height).toBe(CANVAS_HEIGHT - RECT.top);
		expect(tile.data.length).toBe(tile.width * tile.height * 4);
	});

	test("keeps the whole frame for a fully transparent tile", async () => {
		// scanArtBounds' `maxX === -1` sentinel. Shouldn't happen for real card art, but the fallback
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

	test("produces byte-identical buffers across two renders of the same fixture", async () => {
		// `Buffer.alloc` zero-fills before the copy loop overwrites it; `Buffer.allocUnsafe` would
		// reuse whatever heap bytes were previously there. Every row this crop copies is fully
		// in-bounds (the guard above proved that), so the copy loop already overwrites every byte of
		// the destination. But that guarantee is exactly the one worth pinning down: if a future edit
		// ever left a row short, allocUnsafe's recycled memory would make the trailing bytes
		// non-deterministic between calls, where alloc's zero-fill would not.
		const bytes = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT);

		const first = await trimToArt(bytes);
		const second = await trimToArt(bytes);

		expect(Buffer.compare(first.data, second.data)).toBe(0);
	});
});
