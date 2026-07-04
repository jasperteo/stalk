import type { Image } from "@matmen/imagescript";

import type { Card } from "@/schema.ts";

/**
 * ImageScript is imported lazily: its module evaluation compiles ~1.8 MB of codec WASM
 * (svg/gif/font/jpeg/tiff/png), and this file sits on the unconditional main.ts → discord.ts import
 * path — a static import would tax every isolate cold boot, though most never render. The runtime
 * caches the module, so only the first render pays.
 */
const loadImageScript = () => import("@matmen/imagescript");

/** Uniform tile width; height follows the source aspect ratio (`RESIZE_AUTO`). */
const TILE_WIDTH = 100;
const COLUMNS = 4;
/** Transparent gutter between tiles, in pixels. */
const GAP = 4;

/**
 * Decoded, resized tiles keyed by icon URL. Only ~120 distinct card arts exist, and warm isolates
 * keep the map across cron ticks, so after warmup most renders skip the fetch+decode entirely.
 * Caching the _promise_ (not the image) also dedupes concurrent fetches — both decks of a battle,
 * and all targets on a cron tick, render in parallel. `composite` reads its source without mutating
 * it, so sharing cached tiles across renders is safe.
 */
const tileCache = new Map<string, Promise<Image>>();

/**
 * Which `iconUrls` variant each `evolutionLevel` uses (1 = Evolution, 2 = Hero). The `satisfies`
 * clause keeps this table — like `EVOLUTION_PREFIX` in discord.ts — in lockstep with the schema's
 * picklist: a new level fails to compile here instead of silently falling through.
 */
const EVOLUTION_ICON = {
	1: "evolutionMedium",
	2: "heroMedium",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, keyof Card["iconUrls"]>;

/**
 * CDN art for the card as it was played; a card without its variant field — or without an
 * `evolutionLevel` at all — falls back to the always-present `medium`, so it never renders blank.
 */
function iconUrl(card: Card) {
	const variant = card.evolutionLevel
		? card.iconUrls[EVOLUTION_ICON[card.evolutionLevel]]
		: undefined;
	return variant ?? card.iconUrls.medium;
}

async function fetchTile(url: string): Promise<Image> {
	const [{ Image }, response] = await Promise.all([loadImageScript(), fetch(url)]);

	if (!response.ok) {
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	const decoded = await Image.decode(new Uint8Array(await response.arrayBuffer()));

	return decoded.resize(TILE_WIDTH, Image.RESIZE_AUTO);
}

function loadTile(url: string): Promise<Image> {
	const cached = tileCache.get(url);

	if (cached !== undefined) {
		return cached;
	}

	const pending = fetchTile(url);

	tileCache.set(url, pending);
	// Evict on failure so one bad fetch doesn't poison the cache forever; callers still see the
	// rejection through their own await.
	pending.catch(() => tileCache.delete(url));

	return pending;
}

/**
 * Composites a deck into a 4-column PNG grid (2 rows for a full 8-card deck; short decks simply
 * leave trailing cells empty). Throws on an empty deck or an icon fetch/decode failure — the caller
 * falls back to the text-only message. Logs elapsed ms and cache misses so the real per-game CPU
 * cost is observable in Deploy logs.
 */
async function renderDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	const [first] = cards;

	if (first === undefined) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	const cachedBefore = tileCache.size;
	const [{ Image }, tiles] = await Promise.all([
		loadImageScript(),
		Promise.all(cards.map((card) => loadTile(iconUrl(card)))),
	]);
	const fetched = tileCache.size - cachedBefore;

	const composeStart = performance.now();
	const rows = Math.ceil(tiles.length / COLUMNS);
	// All CR card art shares one aspect ratio, but take the max height so an outlier can't overlap.
	const tileHeight = Math.max(...tiles.map((tile) => tile.height));
	const width = COLUMNS * TILE_WIDTH + (COLUMNS - 1) * GAP;
	const height = rows * tileHeight + (rows - 1) * GAP;
	const canvas = new Image(width, height);

	for (const [index, tile] of tiles.entries()) {
		const x = (index % COLUMNS) * (TILE_WIDTH + GAP);
		const y = Math.floor(index / COLUMNS) * (tileHeight + GAP);
		canvas.composite(tile, x, y);
	}

	// Re-wrap onto a fresh ArrayBuffer: ImageScript types encode() as Uint8Array<ArrayBufferLike>,
	// which BlobPart (File/FormData) rejects. One small copy per render.
	const png = new Uint8Array(await canvas.encode());
	const end = performance.now();

	console.log(
		`deck grid: ${String(tiles.length)} tiles (${String(fetched)} fetched) in ${(end - start).toFixed(0)}ms (compose+encode ${(end - composeStart).toFixed(0)}ms)`
	);

	return png;
}

export { renderDeckGrid };
