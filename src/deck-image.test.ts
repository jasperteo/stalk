import { Image } from "@matmen/imagescript";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { CELL_HEIGHT, CELL_WIDTH, renderDeckGrid } from "@/deck-image.ts";
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
const fixtureImage = new Image(TILE_WIDTH, TILE_HEIGHT);
fixtureImage.fill(Image.rgbaToColor(200, 30, 30, 255));
const FIXTURE = new Uint8Array(await fixtureImage.encode());

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

describe("renderDeckGrid", () => {
	test("lays out a 4-column grid at the fixed cell resolution", async () => {
		const eightCards = Array.from({ length: 8 }, () => card());

		// The two renders share no cache entries (distinct ids), so they can overlap — this is the
		// suite's most expensive test (9 tile decode round-trips).
		const [grid, singleRow] = await Promise.all([
			renderDeckGrid(eightCards).then((png) => Image.decode(png)),
			renderDeckGrid([card()]).then((png) => Image.decode(png)),
		]);

		// Cell size is fixed (CELL_WIDTH/CELL_HEIGHT), not derived from the tiles in the deck, so even
		// this small fixture (well under either dimension) composites into a full-size row, and a lone
		// card still reserves the full 4-column width with trailing cells empty.
		expect(singleRow.height).toBe(CELL_HEIGHT);
		expect(singleRow.width).toBeGreaterThanOrEqual(4 * CELL_WIDTH);
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
});
