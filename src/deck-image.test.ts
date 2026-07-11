import { Image } from "@matmen/imagescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderDeckGrid } from "@/deck-image.ts";
import type { Card } from "@/schema.ts";

vi.mock("@/log.ts");

// `tileCache`/`deckCache` in deck-image.ts are module-level and persist for the whole test file, so
// every card gets an icon URL derived from its own name — otherwise two tests sharing the default
// icon URL would silently hit each other's cached (or failed) tile.
function card(overrides: Partial<Card> = {}): Card {
	const name = overrides.name ?? "Knight";

	return {
		name,
		evolutionLevel: undefined,
		iconUrls: { medium: `https://api.clashroyale.com/${name.toLowerCase()}-icon.png` },
		...overrides,
	};
}

const TILE_WIDTH = 20;
const TILE_HEIGHT = 30;

/**
 * A small, fully-opaque solid-color PNG, encoded once for the whole file — the bytes are read-only
 * (each `fetchServingFixture` response wraps its own copy), so every test can serve the same
 * buffer.
 */
const fixtureImage = new Image(TILE_WIDTH, TILE_HEIGHT);
fixtureImage.fill(Image.rgbaToColor(200, 30, 30, 255));
const FIXTURE = new Uint8Array(await fixtureImage.encode());

function fetchServingFixture() {
	return vi.fn((_url: string, _init?: RequestInit) =>
		Promise.resolve(new Response(new Uint8Array(FIXTURE)))
	);
}

let fetchMock: ReturnType<typeof fetchServingFixture>;

beforeEach(() => {
	fetchMock = fetchServingFixture();
	vi.stubGlobal("fetch", fetchMock);
});

describe("renderDeckGrid", () => {
	it("lays out a 4-column grid at native tile resolution", async () => {
		const eightCards = Array.from({ length: 8 }, (_, index) =>
			card({ name: `card-${String(index)}` })
		);

		// The two renders share no cache entries (distinct card names → distinct URLs), so they can
		// overlap — this is the suite's most expensive test (9 tile encode/decode round-trips).
		const [grid, singleRow] = await Promise.all([
			renderDeckGrid(eightCards).then((png) => Image.decode(png)),
			renderDeckGrid([card({ name: "solo-card" })]).then((png) => Image.decode(png)),
		]);

		// Native resolution: one row is exactly one tile high (the fixture has no transparent margin
		// to trim), and a lone card still reserves the full 4-column width with trailing cells empty.
		expect(singleRow.height).toBe(TILE_HEIGHT);
		expect(singleRow.width).toBeGreaterThanOrEqual(4 * TILE_WIDTH);
		// The full deck spans the same 4 columns and adds a second row. Asserted relative to the
		// single-row render rather than against COLUMN_GAP/ROW_GAP, which are tuning knobs.
		expect(grid.width).toBe(singleRow.width);
		expect(grid.height).toBeGreaterThan(singleRow.height);
	});

	it("throws when the icon fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("nope", { status: 500 })))
		);

		await expect(renderDeckGrid([card({ name: "always-fails" })])).rejects.toThrow(
			"Card icon 500 for"
		);
	});

	it("does not re-fetch a deck it has already rendered", async () => {
		const cards = [card({ name: "repeat-card" })];

		await renderDeckGrid(cards);
		const callsAfterFirst = fetchMock.mock.calls.length;
		await renderDeckGrid(cards);

		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("re-fetches for a different deck", async () => {
		await renderDeckGrid([card({ name: "deck-a" })]);
		const callsAfterFirst = fetchMock.mock.calls.length;
		await renderDeckGrid([card({ name: "deck-b" })]);

		expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});

	it("fetches the evolutionMedium/heroMedium icon variant for Evo/Hero cards", async () => {
		await renderDeckGrid([
			card({
				name: "evo-card",
				evolutionLevel: 1,
				iconUrls: {
					medium: "https://api.clashroyale.com/evo-card-icon.png",
					evolutionMedium: "https://api.clashroyale.com/evo-card-evo.png",
				},
			}),
			card({
				name: "hero-card",
				evolutionLevel: 2,
				iconUrls: {
					medium: "https://api.clashroyale.com/hero-card-icon.png",
					heroMedium: "https://api.clashroyale.com/hero-card-hero.png",
				},
			}),
		]);

		const urls = fetchMock.mock.calls.map((call) => call[0]);

		expect(urls).toContain("https://api.clashroyale.com/evo-card-evo.png");
		expect(urls).toContain("https://api.clashroyale.com/hero-card-hero.png");
		expect(urls).not.toContain("https://api.clashroyale.com/evo-card-icon.png");
		expect(urls).not.toContain("https://api.clashroyale.com/hero-card-icon.png");
	});

	it("falls back to medium when an Evo/Hero card has no variant icon", async () => {
		await renderDeckGrid([
			card({
				name: "no-variant-card",
				evolutionLevel: 1,
				iconUrls: { medium: "https://api.clashroyale.com/no-variant-card-icon.png" },
			}),
		]);

		const urls = fetchMock.mock.calls.map((call) => call[0]);

		expect(urls).toContain("https://api.clashroyale.com/no-variant-card-icon.png");
	});

	it("HACK: renders Ronin from the override URL, padded onto the shared baseline", async () => {
		const grid = await renderDeckGrid([card({ name: "Ronin" })]).then((png) => Image.decode(png));
		const urls = fetchMock.mock.calls.map((call) => call[0]);

		expect(urls).toEqual([expect.stringContaining("royaleapi.com")]);
		expect(urls).not.toContain("https://api.clashroyale.com/ronin-icon.png");
		// The fixture's bottom edge is flush, so the 12px pad is the whole added height.
		expect(grid.height).toBe(TILE_HEIGHT + 12);
	});
});
