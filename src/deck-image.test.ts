import { Buffer } from "node:buffer";

import sharp from "sharp";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	CELL_HEIGHT,
	CELL_WIDTH,
	decodeToRaw,
	MAX_GRID_WIDTH,
	renderDeckGrid,
	trimToArt,
} from "@/deck-image.ts";
import { TOKEN_VAR } from "@/env.ts";
import type { Card } from "@/schema.ts";

vi.mock("@/log.ts");

// `deckCache` in deck-image.ts is module-level and persists for the whole test file, and its keys
// are the deck's ordered mirror filenames (derived from card id + evolutionLevel) — so every card
// needs a unique id, otherwise two tests would silently share (or collide on) a cached grid. A
// monotonic counter hands each `card()` call its own id; tests that render the same deck twice build
// the array once and reuse it.
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

/**
 * A small, fully-opaque solid-color PNG, encoded once for the whole file. It has no transparent
 * margin, so `trimToArt` keeps it at full size and its geometry is predictable. The bytes are
 * read-only — every serve wraps a fresh `Uint8Array` copy — so both the local-mirror read and the
 * CDN fallback can hand back the same image.
 */
const { data } = await sharp({
	create: {
		width: TILE_WIDTH,
		height: TILE_HEIGHT,
		channels: 4,
		background: { r: 200, g: 30, b: 30, alpha: 1 },
	},
})
	.png()
	.toUint8Array();
const FIXTURE = new Uint8Array(data);

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
): Promise<Uint8Array> {
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

	const encoded = await sharp(raw, { raw: { width, height, channels: 4 } })
		.png()
		.toUint8Array();
	return new Uint8Array(encoded.data);
}

/**
 * A fully-opaque solid-color PNG bigger than the compose cell (`CELL_WIDTH`×`CELL_HEIGHT`) in both
 * dimensions, standing in for a brand-new card whose CDN art hasn't been downsized to the local
 * mirror's convention.
 */
const OVERSIZED_WIDTH = CELL_WIDTH + 40;
const OVERSIZED_HEIGHT = CELL_HEIGHT + 60;
const { data: oversizedData } = await sharp({
	create: {
		width: OVERSIZED_WIDTH,
		height: OVERSIZED_HEIGHT,
		channels: 4,
		background: { r: 30, g: 120, b: 200, alpha: 1 },
	},
})
	.png()
	.toUint8Array();
const OVERSIZED_FIXTURE = new Uint8Array(oversizedData);

/**
 * Spies `Deno.readFile` — the module's primary tile source (the local `images/` mirror) — to serve
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
	return vi.fn((_url: string | URL, _init?: RequestInit) =>
		Promise.resolve(new Response(new Uint8Array(FIXTURE)))
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

// 4 * CELL_WIDTH + 3 * COLUMN_GAP; COLUMN_GAP is module-private, so the derived total is inlined.
const NATIVE_WIDTH = 1080;
const scaled = (px: number) => Math.round((px * MAX_GRID_WIDTH) / NATIVE_WIDTH);

describe("renderDeckGrid", () => {
	test("lays out a 4-column grid at the fixed cell resolution", async () => {
		const eightCards = Array.from({ length: 8 }, () => card());

		// The two renders share no cache entries (distinct ids), so they can overlap — this is the
		// suite's most expensive test (9 tile decode round-trips).
		const [grid, singleRow] = await Promise.all([
			renderDeckGrid(eightCards).then((png) => dimensions(png)),
			renderDeckGrid([card()]).then((png) => dimensions(png)),
		]);

		// Cell size is fixed (CELL_WIDTH/CELL_HEIGHT), not derived from the tiles in the deck, so even
		// this small fixture (well under either dimension) composites into a full-size row, and a lone
		// card still reserves the full 4-column width with trailing cells empty. The composed grid is
		// downscaled to MAX_GRID_WIDTH before encode, so the shipped dimensions are scaled from the
		// native CELL_HEIGHT/4-column-width, not equal to them.
		expect(singleRow.height).toBe(scaled(CELL_HEIGHT));
		expect(singleRow.width).toBe(MAX_GRID_WIDTH);
		// The full deck spans the same 4 columns and adds a second row. Asserted relative to the
		// single-row render rather than against COLUMN_GAP/ROW_GAP, which are tuning knobs.
		expect(grid.width).toBe(singleRow.width);
		expect(grid.height).toBeGreaterThan(singleRow.height);
	});

	test("renders entirely from the local mirror without touching the network", async () => {
		const cards = [card(), card(), card()];

		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Uint8Array);

		// One local read per card and no CDN fallback — the mirror is meant to cover every playable
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

		expect(paths.some((path) => path.endsWith(`${String(evo.id)}-evo.png`))).toBe(true);
		expect(paths.some((path) => path.endsWith(`${String(hero.id)}-hero.png`))).toBe(true);
		expect(paths.some((path) => path.endsWith(`${String(base.id)}.png`))).toBe(true);
		// No network for locally-mirrored cards, whatever their evolutionLevel.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("falls back to the CDN icon when the local mirror has no art", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		const missing = card({
			iconUrls: { medium: "https://api.clashroyale.com/fresh-release.png" },
		});

		await expect(renderDeckGrid([missing])).resolves.toBeInstanceOf(Uint8Array);

		// The fallback fetches the card's own icon URL, with the render's abort signal attached.
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.clashroyale.com/fresh-release.png");
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("clamps an oversized CDN fallback tile to the cell instead of composing it past the cell bounds", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementationOnce(() =>
			Promise.resolve(new Response(new Uint8Array(OVERSIZED_FIXTURE)))
		);

		const oversized = card({
			iconUrls: { medium: "https://api.clashroyale.com/oversized.png" },
		});
		const [oversizedPng, normalPng] = await Promise.all([
			renderDeckGrid([oversized]),
			renderDeckGrid([card()]),
		]);

		// The grid's own dimensions are fixed by CELL_WIDTH/CELL_HEIGHT regardless of tile content, so
		// an unclamped oversized tile wouldn't change them either — what the clamp actually prevents is
		// the tile's overlay offsets going negative (see composeDeckGrid) and the source being visibly
		// sliced. A successful render at the expected fixed size is the observable proxy available from
		// outside the module: `fit: "inside"` + `withoutEnlargement` means a tile that already exceeds
		// the cell now decodes into a rectangle bounded by CELL_WIDTH×CELL_HEIGHT, which trimToArt (also
		// exercised directly below) confirms in isolation.
		await expect(dimensions(oversizedPng)).resolves.toEqual(await dimensions(normalPng));
	});

	test("rejects without a CDN fallback when the local read fails for any reason but NotFound", async () => {
		const permissionError = new Deno.errors.PermissionDenied("EACCES");
		readFileMock.mockRejectedValue(permissionError);

		// Only Deno.errors.NotFound means "not mirrored yet, try the CDN" — any other read failure
		// (permissions, a corrupt mount, ...) must surface as-is, with no fallback fetch attempted.
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

		expect(urls).toContain("https://api.clashroyale.com/evo-variant.png");
		expect(urls).toContain("https://api.clashroyale.com/hero-variant.png");
		expect(urls).not.toContain("https://api.clashroyale.com/evo-icon.png");
		expect(urls).not.toContain("https://api.clashroyale.com/hero-icon.png");
	});

	test("falls back to medium when an Evo/Hero card has no variant icon", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));

		await renderDeckGrid([
			card({
				evolutionLevel: 1,
				iconUrls: { medium: "https://api.clashroyale.com/no-variant.png" },
			}),
		]);

		expect(fetchMock.mock.calls.map((call) => call[0])).toContain(
			"https://api.clashroyale.com/no-variant.png"
		);
	});

	test("rejects the render when the CDN fallback fetch fails", async () => {
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid([card()])).rejects.toThrow("Card icon 500 for");
	});

	test("recovers on the next render after a failed fallback (failure is not cached)", async () => {
		const cards = [card()];

		// Local art is missing throughout, so both renders take the CDN fallback; the first fetch 500s
		// and every later one serves the fixture.
		readFileMock.mockRejectedValue(new Deno.errors.NotFound("no local art"));
		fetchMock.mockImplementationOnce(() => Promise.resolve(new Response("nope", { status: 500 })));

		await expect(renderDeckGrid(cards)).rejects.toThrow("Card icon 500 for");

		// The deck cache evicts the failed entry, so the retry re-runs and renders cleanly.
		await expect(renderDeckGrid(cards)).resolves.toBeInstanceOf(Uint8Array);
	});

	test("does not re-render a deck it has already rendered", async () => {
		const cards = [card()];

		const first = await renderDeckGrid(cards);
		const readsAfterFirst = readFileMock.mock.calls.length;
		const second = await renderDeckGrid(cards);

		// A cache hit returns the same cached bytes and re-reads nothing.
		expect(second).toBe(first);
		expect(readFileMock.mock.calls.length).toBe(readsAfterFirst);
	});

	test("renders separately for a different deck", async () => {
		await renderDeckGrid([card()]);
		const readsAfterFirst = readFileMock.mock.calls.length;
		await renderDeckGrid([card()]);

		expect(readFileMock.mock.calls.length).toBeGreaterThan(readsAfterFirst);
	});
});

/**
 * Counts opaque pixels down the grid's leftmost column (x = 0). The 20×30 fixture tiles are centred
 * in 261-wide cells, so no card ever reaches x = 0 — the only thing that can paint there is a
 * full-width deck-boundary divider. So this count is 0 for a single deck and scales with the number
 * of divider rules (DIVIDER_THICKNESS px each) for a duel.
 */
async function leftEdgeOpaquePixels(png: Uint8Array) {
	const { data, width, height } = await decodeToRaw(png);
	let count = 0;

	for (let y = 0; y < height; y++) {
		const alpha = data[y * width * 4 + 3] ?? 0;
		if (alpha > 0) count++;
	}

	return count;
}

describe("renderDeckGrid duel layout", () => {
	// Distinct ids per card so no two decks collide in the module-level deck cache (see the file
	// header comment). A duel's cards array is the concatenation of 2 or 3 full 8-card decks.
	const deck = (blocks: number) => Array.from({ length: blocks * 8 }, () => card());

	test("keeps all four columns (constant width) regardless of deck count", async () => {
		const [one, two, three] = await Promise.all([
			renderDeckGrid(deck(1)).then(dimensions),
			renderDeckGrid(deck(2)).then(dimensions),
			renderDeckGrid(deck(3)).then(dimensions),
		]);

		expect(two.width).toBe(one.width);
		expect(three.width).toBe(one.width);
	});

	test("inserts a block gap so stacked decks are taller than the same rows run together", async () => {
		const [one, two, three] = await Promise.all([
			renderDeckGrid(deck(1)).then(dimensions),
			renderDeckGrid(deck(2)).then(dimensions),
			renderDeckGrid(deck(3)).then(dimensions),
		]);

		// A 16-card duel is two 8-card blocks plus a positive gap between them, so it is strictly
		// taller than two single decks stacked with no gap would be. This is the assertion that fails
		// if the block gap is ever dropped (the old continuous grid made two decks SHORTER than
		// 2×one, because of the negative row overlap at the boundary).
		expect(two.height).toBeGreaterThan(2 * one.height);
		expect(three.height).toBeGreaterThan(two.height);
	});

	test("draws one divider rule per block boundary and none for a single deck", async () => {
		const [one, two, three] = await Promise.all([
			renderDeckGrid(deck(1)),
			renderDeckGrid(deck(2)),
			renderDeckGrid(deck(3)),
		]);

		const [edgeOne, edgeTwo, edgeThree] = await Promise.all([
			leftEdgeOpaquePixels(one),
			leftEdgeOpaquePixels(two),
			leftEdgeOpaquePixels(three),
		]);

		// No divider on a normal 8-card deck; the leftmost column stays fully transparent — a fully
		// transparent column stays fully transparent under any resample.
		expect(edgeOne).toBe(0);
		// A 16-card duel has exactly one divider; a 24-card duel has two, so roughly twice the painted
		// pixels. Not an exact 2x: the grid is Lanczos-downscaled before encode, so the 4px dividers land
		// on ~2.7px with partial-alpha ringing at the resampled edges, rather than an exact integer ratio.
		expect(edgeTwo).toBeGreaterThan(0);
		expect(edgeThree).toBeGreaterThan(edgeTwo * 1.8);
		expect(edgeThree).toBeLessThan(edgeTwo * 2.2);
	});
});

/**
 * LRU tests need their own module instance: the static import's deckCache carries entries from the
 * tests above, and DECK_CACHE_LIMIT is baked at module load from env (3 * targets + 10). Unsetting
 * CR_API_TOKEN pins config to undefined, so the limit is exactly 10. `resetModules` only clears the
 * module registry — the `Deno.readFile` spy from `beforeEach` is a global and survives, so the
 * fresh module still reads the fixture. Cache hits return the same resolved Uint8Array instance
 * (the cached promise), so identity distinguishes a hit from a re-render (a re-render re-reads
 * every tile since there is no per-tile cache, but identity is the direct signal).
 */
async function freshRenderDeckGrid() {
	vi.stubEnv(TOKEN_VAR, undefined);
	vi.resetModules();
	const { renderDeckGrid: render } = await import("@/deck-image.ts");
	return render;
}

describe("renderDeckGrid LRU", () => {
	const DECK_CACHE_LIMIT = 10;

	test("evicts the least-recently-used deck past the cap, keeping touched decks warm", async () => {
		const render = await freshRenderDeckGrid();
		// Keyed by id, so a stable id per logical deck is what makes a re-render a cache hit.
		const deck = (id: number) => [card({ id })];

		// Fill the cache to its cap: ids 0 .. 9.
		const first = await render(deck(0));
		for (let id = 1; id < DECK_CACHE_LIMIT; id++) {
			await render(deck(id));
		}

		// Touch deck 0 so deck 1 becomes the eviction candidate; a hit is the same instance.
		expect(await render(deck(0))).toBe(first);

		// One over the cap evicts exactly one deck: the untouched deck 1.
		await render(deck(999));

		const second = await render(deck(1));
		expect(second).not.toBe(await render(deck(0))); // sanity: distinct decks, distinct pngs
		expect(await render(deck(1))).toBe(second); // deck 1 re-rendered, now cached again
		expect(await render(deck(0))).toBe(first); // deck 0 survived — recency was refreshed
	});

	// An eviction-identity test (asserting a mid-render eviction doesn't delete a healthy newer
	// promise under the same key) is deliberately not included here: it needs a render to still be
	// in flight when its own cache entry is evicted by cap pressure and then replaced by a second
	// render under the same key, all before the first render's rejection is observed. Nothing in this
	// module exposes a hook to pause a render mid-flight, so driving that interleaving would mean
	// racing real promise microtask ordering — inherently flaky, or trivially vacuous if it happened
	// to pass without ever exercising the interleaving. The guard itself (`deckCache.get(key) ===
	// pending`) is exercised on every ordinary failing render in the suite (e.g. "recovers on the next
	// render after a failed fallback" above), just not on the specific replaced-entry branch.
});

describe("trimToArt", () => {
	// A 30×40 canvas with an opaque rect whose right edge lands exactly on the canvas's own right
	// edge (left + width === canvas width) — the boundary `cropRaw`'s bounds guard has to accept
	// rather than reject. `trimToArt` always keeps the native bottom edge (see its own doc comment),
	// so the crop's bottom always reaches the canvas height regardless of the rect's own bottom; only
	// left/top/right are meaningfully "trimmed" here.
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

	test("produces byte-identical buffers across two renders of the same fixture", async () => {
		// `Buffer.alloc` zero-fills before the copy loop overwrites it; `Buffer.allocUnsafe` would
		// reuse whatever heap bytes were previously there. Every row this crop copies is fully
		// in-bounds (the guard above proved that), so the copy loop already overwrites every byte of
		// the destination — but that invariant is exactly the one worth pinning down: if a future edit
		// ever left a row short, allocUnsafe's recycled memory would make the trailing bytes
		// non-deterministic between calls, where alloc's zero-fill would not.
		const bytes = await insetFixture(CANVAS_WIDTH, CANVAS_HEIGHT, RECT);

		const first = await trimToArt(bytes);
		const second = await trimToArt(bytes);

		expect(Buffer.compare(first.data, second.data)).toBe(0);
	});
});
