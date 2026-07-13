import type { Image } from "@matmen/imagescript";
import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";

import { config } from "@/env.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * ImageScript is imported lazily: its module evaluation compiles ~1.8 MB of codec WASM
 * (svg/gif/font/jpeg/tiff/png), and this file sits on the unconditional main.ts → discord.ts import
 * path — a static import would tax every isolate cold boot, though most never render. The runtime
 * caches the module, so only the first render pays.
 */
const loadImageScript = () => import("@matmen/imagescript");

const COLUMNS = 4;
/**
 * Gutter between columns, in native pixels. Tiles are trimmed on the sides, so this is the true
 * gap.
 */
const COLUMN_GAP = 12;
/**
 * Gutter between rows. Negative: the upper row keeps its native bottom padding (`trimToArt`), which
 * is transparent, so a small overlap tightens the rows without clipping any card art. Don't go
 * below roughly -20 — a top row of hexagon/champion frames has less bottom padding to overlap
 * into.
 */
const ROW_GAP = -16;
/** Alpha at or below this counts as transparent when trimming the card's margin. */
const ALPHA_THRESHOLD = 8;
/**
 * PNG deflate level, 0–9, for the shipped grid. Lossless, so it trades encode CPU for upload size.
 * The deck cache amortizes this encode across every repeat post of the deck, so if Deploy egress
 * ever becomes the tight budget, raising this toward 9 is the cheap first lever.
 */
const GRID_COMPRESSION = 6;
/**
 * PNG deflate level for cached tile bytes. These are memory-resident only — egress never applies —
 * so only deflate's knee is worth paying: the top levels cost disproportionate CPU for a further
 * ~1–3%.
 */
const TILE_COMPRESSION = 6;
/**
 * Abort a card-icon CDN fetch after this long. Icons fetch in parallel per deck, so this bounds the
 * whole tile-load phase; a timeout rejects the render and discord.ts falls back to the text-only
 * message instead of the tick hanging.
 */
const ICON_TIMEOUT_MS = 10_000;
/**
 * Finished grids kept per distinct deck, sized from the live target count: each tracked player
 * needs a warm entry per side they appear on, and the headroom absorbs one-shot opponent decks.
 * Deriving from `config` means growing TARGETS can't silently push warm decks into eviction churn.
 * At a few hundred KB per PNG the cap stays in the tens of MB.
 */
const DECK_CACHE_LIMIT = 3 * (config?.targets.length ?? 0) + 10;

/**
 * A trimmed icon ready to composite, plus the transparent bottom margin the art kept (`trimToArt`
 * preserves the native bottom edge) — the compose layer needs the padding to know how far a row
 * below may overlap without clipping.
 */
type Tile = {
	image: Image;
	bottomPadding: number;
};

/**
 * A `Tile` in cache form: the bitmap deflated back to PNG bytes. Compressed, a tile costs a
 * fraction of its decoded RGBA bitmap, which is what keeps a warm isolate holding every distinct
 * card art bounded.
 */
type CachedTile = {
	png: Uint8Array;
	bottomPadding: number;
};

/**
 * Trimmed tiles keyed by icon URL. Only ~120 distinct card arts exist, and warm isolates keep the
 * map across cron ticks, so after warmup renders skip the CDN fetch, decode, and trim scan. Caching
 * the _promise_ (not the value) also dedupes concurrent fetches — both decks of a battle, and all
 * targets on a cron tick, render in parallel.
 */
const tileCache = new Map<string, Promise<CachedTile>>();

/**
 * Finished grids keyed by the deck's ordered icon URLs. Players run one deck for many battles in a
 * row, so the expensive part (tile load, compose, encode) runs once per deck instead of once per
 * battle. Small LRU: hits re-insert at the back, inserts evict from the front, so tracked players'
 * decks stay warm while one-shot opponent decks churn through. Sharing the cached bytes across
 * posts is safe — callers only wrap them in a `File`, never mutate them.
 */
const deckCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

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

/**
 * Trims a decoded icon's transparent margin on the top and sides, but keeps its native bottom edge.
 * Each card PNG bakes in a margin (~5% per side, plus a ~10% band on top) that otherwise reads as
 * extra space between cards. The bottom is left intact deliberately: the game renders every icon on
 * the same canvas, so the native bottom is a consistent baseline across rarities — bottom-aligning
 * on it (see `composeDeckGrid`) lines the card frames up, whereas trimming to each card's own
 * lowest opaque pixel would follow per-card shadow/decoration variation instead. Kept at native
 * resolution — the only resize ImageScript offers is nearest-neighbour, which softens detailed
 * art.
 */
function trimToArt(image: Image): Tile {
	const { bitmap, width, height } = image;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	// Walk the raw RGBA bitmap with a running offset (alpha is byte 3 of each quad) — this scans
	// every pixel, and per-pixel getPixelAt would pay a bounds-check call plus a big-endian u32 read
	// each time.
	let offset = 3;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++, offset += 4) {
			if ((bitmap[offset] ?? 0) > ALPHA_THRESHOLD) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	// Fully transparent (shouldn't happen for card art): leave it rather than crop to nothing. All
	// padding, so no overlap can clip art.
	if (maxX < 0) {
		return { image, bottomPadding: height };
	}

	return {
		image: image.crop(minX, minY, maxX - minX + 1, height - minY),
		bottomPadding: height - 1 - maxY,
	};
}

async function fetchTile(url: string): Promise<Tile> {
	const [{ Image }, response] = await Promise.all([
		loadImageScript(),
		fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) }),
	]);

	if (!response.ok) {
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	return trimToArt(await Image.decode(new Uint8Array(await response.arrayBuffer())));
}

/** Inflates a cached tile back into a working bitmap for compositing. */
async function inflateTile(cached: Promise<CachedTile>): Promise<Tile> {
	const [{ Image }, { png, bottomPadding }] = await Promise.all([loadImageScript(), cached]);

	return { image: await Image.decode(png), bottomPadding };
}

/**
 * Loads a tile ready to composite. A hit inflates a fresh bitmap from the cached PNG bytes; a miss
 * hands the render the live decoded image directly and fills the cache with deflated bytes as a
 * derived promise — so a cold render never pays an encode→decode round trip of its own making, and
 * the cache-fill deflate stays off the render's critical path. Each tile resolves independently, so
 * warm inflates overlap in-flight cold fetches instead of waiting for the slowest one.
 */
function loadTile(url: string): Promise<Tile> {
	const cached = tileCache.get(url);

	if (cached !== undefined) {
		return inflateTile(cached);
	}

	const pending = fetchTile(url);
	const compressed = pending.then(
		async ({ image, bottomPadding }): Promise<CachedTile> => ({
			png: await image.encode(TILE_COMPRESSION),
			bottomPadding,
		})
	);

	tileCache.set(url, compressed);
	// Evict on failure so one bad fetch doesn't poison the cache forever; the racing render still
	// sees the rejection through its own await on `pending`.
	compressed.catch(() => tileCache.delete(url));

	return pending;
}

/**
 * Composites a deck into a 4-column PNG grid (2 rows for a full 8-card deck; short decks simply
 * leave trailing cells empty). Runs once per deck-cache miss — `renderDeckGrid` is the cached front
 * door — and logs elapsed ms, tile-cache misses, and output size, so the per-distinct-deck render
 * cost is observable in Deploy logs.
 */
async function composeDeckGrid(urls: string[]): Promise<Uint8Array<ArrayBuffer>> {
	if (urls.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	const cachedBefore = tileCache.size;
	const [{ Image }, tiles] = await Promise.all([
		loadImageScript(),
		Promise.all(urls.map((url) => loadTile(url))),
	]);
	const fetched = tileCache.size - cachedBefore;

	const composeStart = performance.now();
	// One cell size for every card, so all rows are equal height and the grid stays consistent
	// across decks. Trimmed tiles vary slightly, so take the max for both dimensions.
	const tileWidth = Math.max(...tiles.map((tile) => tile.image.width));
	const tileHeight = Math.max(...tiles.map((tile) => tile.image.height));
	const rows = Math.ceil(tiles.length / COLUMNS);
	const width = COLUMNS * tileWidth + (COLUMNS - 1) * COLUMN_GAP;
	const height = rows * tileHeight + (rows - 1) * ROW_GAP;
	const canvas = new Image(width, height);

	for (const [index, { image: tile, bottomPadding }] of tiles.entries()) {
		const row = Math.floor(index / COLUMNS);

		// The negative ROW_GAP overlaps the row below into this tile's kept bottom padding; if the
		// art leaves less padding than the overlap (e.g. a future frame style), it would clip — say
		// so. Bottom-row tiles have no row below them, so they can't clip.
		if (row < rows - 1 && bottomPadding < -ROW_GAP) {
			log.warn(
				`card art bottom padding ${hl.strong(String(bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
			);
		}

		// Centre horizontally, align to the cell's bottom. Tiles keep their native bottom edge
		// (`trimToArt`), so bottom-aligning rests every card on the same baseline; taller frames
		// (hexagonal legendaries/champions) and gems/emblems (evolutions/heroes) extend upward, the
		// way the art is drawn. Centring would leave shorter cards floating and off-centre.
		const cellX = (index % COLUMNS) * (tileWidth + COLUMN_GAP);
		const cellY = row * (tileHeight + ROW_GAP);
		const x = cellX + Math.floor((tileWidth - tile.width) / 2);
		const y = cellY + (tileHeight - tile.height);
		canvas.composite(tile, x, y);
	}

	// Re-wrap onto a fresh ArrayBuffer: ImageScript types encode() as Uint8Array<ArrayBufferLike>,
	// which BlobPart (File/FormData) rejects. One small copy per render.
	const png = new Uint8Array(await canvas.encode(GRID_COMPRESSION));
	const end = performance.now();

	// Size is worth logging: tiles composite at whatever resolution the CDN serves (no resize), so a
	// CDN art upgrade would silently grow every upload toward Discord's attachment limit.
	const elapsed = formatDuration(Math.round(end - start), { ignoreZero: true });
	const composeElapsed = formatDuration(Math.round(end - composeStart), { ignoreZero: true });
	log.debug(
		`deck grid: ${String(tiles.length)} tiles (${String(fetched)} fetched), ${hl.value(formatBytes(png.length))}, in ${elapsed} (compose+encode ${composeElapsed})`
	);

	return png;
}

/**
 * Cached front door for `composeDeckGrid`: the render is deterministic from the deck's ordered icon
 * URLs (`iconUrl` already folds in the Evo/Hero variant), so identical decks reuse the finished PNG
 * — and a quiet Deploy log means cache hits, not missing renders. A hit refreshes the entry's
 * recency; a miss renders, caches the promise (deduping concurrent renders of the same deck), and
 * evicts the least-recently-used deck past the cap. Throws on an empty deck or an icon fetch/decode
 * failure — the caller falls back to the text-only message — and failures evict themselves so a bad
 * render isn't cached.
 */
async function renderDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	const urls = cards.map((card) => iconUrl(card));
	const key = urls.join("|");
	const cached = deckCache.get(key);

	if (cached !== undefined) {
		// Maps iterate in insertion order, so re-inserting moves this deck out of eviction's way.
		deckCache.delete(key);
		deckCache.set(key, cached);
		return cached;
	}

	if (deckCache.size >= DECK_CACHE_LIMIT) {
		const oldest = deckCache.keys().next().value;

		if (oldest !== undefined) {
			deckCache.delete(oldest);
		}
	}

	// Cached before the first await, so concurrent renders of the same deck dedupe on this promise.
	const pending = composeDeckGrid(urls);
	deckCache.set(key, pending);

	try {
		return await pending;
	} catch (error) {
		deckCache.delete(key);
		throw error;
	}
}

export { renderDeckGrid };
