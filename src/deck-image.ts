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

/**
 * The local card-art mirror (`<id>.png`, `<id>-evo.png`, `<id>-hero.png`), resolved relative to
 * this module rather than the cwd so it survives Deno Deploy, where the process cwd is not the repo
 * root. Every playable card ships here, so reads are the hot path and never touch the network.
 */
const IMAGES_DIR = new URL("../images/", import.meta.url);

const COLUMNS = 4;
/**
 * Fixed cell dimensions every tile composites into, so all rows are equal height and the grid stays
 * consistent across decks regardless of which cards are in it. Set to the upper bound of every
 * local icon's trimmed size (`deno task measure`, no args, reports the aggregate) rather than
 * computed per-render from the deck's own tiles, so the grid's pixel dimensions — and the Discord
 * embed layout that depends on them — don't shift between posts.
 */
const CELL_WIDTH = 261;
const CELL_HEIGHT = 387;
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
/** Alpha at or below this counts as transparent when scanning for a card's art bounds. */
const ALPHA_THRESHOLD = 8;
/**
 * PNG deflate level, 0–9, for the shipped grid. Lossless, so it trades encode CPU for upload size.
 * The deck cache amortizes this encode across every repeat post of the deck, so if Deploy egress
 * ever becomes the tight budget, raising this toward 9 is the cheap first lever.
 */
const GRID_COMPRESSION = 6;
/**
 * Abort a fallback card-icon CDN fetch after this long. The fallback only runs for a card absent
 * from the local mirror (a fresh release), and those fetch in parallel per deck, so this bounds the
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
 * Finished grids keyed by the deck's ordered mirror filenames (`tileName`). Players run one deck
 * for many battles in a row, so the expensive part (tile load, compose, encode) runs once per deck
 * instead of once per battle. Small LRU: hits re-insert at the back, inserts evict from the front,
 * so tracked players' decks stay warm while one-shot opponent decks churn through. Sharing the
 * cached bytes across posts is safe — callers only wrap them in a `File`, never mutate them.
 */
const deckCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * Which local-art filename suffix each `evolutionLevel` uses (1 = Evolution, 2 = Hero); ordinary
 * cards use the bare `<id>.png`. The `satisfies` clause keeps this table — like `EVOLUTION_PREFIX`
 * in discord.ts — in lockstep with the schema's picklist: a new level fails to compile here instead
 * of silently falling through to the base art.
 */
const EVOLUTION_SUFFIX = {
	1: "-evo",
	2: "-hero",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, string>;

/** The local mirror filename for the card as it was played: `<id>`, `<id>-evo`, or `<id>-hero`. */
function tileName(card: Card): string {
	const suffix = card.evolutionLevel ? EVOLUTION_SUFFIX[card.evolutionLevel] : "";
	return `${String(card.id)}${suffix}.png`;
}

/**
 * Which `iconUrls` variant each `evolutionLevel` prefers on the CDN-fallback path — the same
 * lockstep `satisfies` guard as `EVOLUTION_SUFFIX`, so a new level fails to compile here too
 * instead of silently fetching the base art.
 */
const EVOLUTION_ICON = {
	1: "evolutionMedium",
	2: "heroMedium",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, keyof Card["iconUrls"]>;

/**
 * CDN art URL for the card as it was played — the fallback source when the local mirror has no file
 * for the card yet. Prefers the played evo/hero variant and falls back to the always-present
 * `medium`, so it never resolves blank.
 */
function iconUrl(card: Card): string {
	const variant = card.evolutionLevel
		? card.iconUrls[EVOLUTION_ICON[card.evolutionLevel]]
		: undefined;
	return variant ?? card.iconUrls.medium;
}

/**
 * Scans a decoded RGBA bitmap for the bounding box of its opaque pixels: the min/max x and y where
 * alpha exceeds `ALPHA_THRESHOLD`. A fully transparent bitmap yields `maxX === -1` (with `minX`/
 * `minY` left at width/height), the sentinel callers must handle. Walks the raw byte array with a
 * running offset (alpha is byte 3 of each RGBA quad) — this scans every pixel, and per-pixel
 * `getPixelAt` would pay a bounds-check call plus a big-endian u32 read each time.
 */
function scanArtBounds({ bitmap, width, height }: Image) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

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

	return { minX, minY, maxX, maxY };
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
	const { height } = image;
	const { minX, minY, maxX, maxY } = scanArtBounds(image);

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

/**
 * Loads a card's tile ready to composite. The local mirror covers every playable card, so the file
 * read is the normal path — decode + trim of a few tiles per deck-cache miss is tens of ms, and the
 * OS page cache absorbs repeats, so no per-tile cache is kept. A `NotFound` means the card released
 * after the last mirror sync: `log.warn` (the signal to add its art) and fall back to the card's
 * CDN icon. `cdnFallback` reports whether that fallback ran, so `composeDeckGrid` can log it. Any
 * fetch/decode error propagates — the render rejects and discord.ts posts its text-only message.
 */
async function loadTile(card: Card): Promise<{ tile: Tile; cdnFallback: boolean }> {
	try {
		const [{ Image }, bytes] = await Promise.all([
			loadImageScript(),
			Deno.readFile(new URL(tileName(card), IMAGES_DIR)),
		]);
		return { tile: trimToArt(await Image.decode(bytes)), cdnFallback: false };
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) {
			throw error;
		}

		log.warn(
			`no local art for card ${hl.entity(String(card.id))} (${card.name}); falling back to the CDN`
		);
		return { tile: await fetchTile(iconUrl(card)), cdnFallback: true };
	}
}

/**
 * Composites a deck into a 4-column PNG grid (2 rows for a full 8-card deck; short decks simply
 * leave trailing cells empty). Runs once per deck-cache miss — `renderDeckGrid` is the cached front
 * door — and logs elapsed ms, CDN fallbacks (normally 0), and output size, so the per-distinct-deck
 * render cost is observable in Deploy logs.
 */
async function composeDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	const [{ Image }, loaded] = await Promise.all([
		loadImageScript(),
		Promise.all(cards.map((card) => loadTile(card))),
	]);
	const fallbacks = loaded.filter((entry) => entry.cdnFallback).length;
	const tiles = loaded.map((entry) => entry.tile);

	const composeStart = performance.now();
	const rows = Math.ceil(tiles.length / COLUMNS);
	const width = COLUMNS * CELL_WIDTH + (COLUMNS - 1) * COLUMN_GAP;
	const height = rows * CELL_HEIGHT + (rows - 1) * ROW_GAP;
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
		const cellX = (index % COLUMNS) * (CELL_WIDTH + COLUMN_GAP);
		const cellY = row * (CELL_HEIGHT + ROW_GAP);
		const x = cellX + Math.floor((CELL_WIDTH - tile.width) / 2);
		const y = cellY + (CELL_HEIGHT - tile.height);
		canvas.composite(tile, x, y);
	}

	// Re-wrap onto a fresh ArrayBuffer: ImageScript types encode() as Uint8Array<ArrayBufferLike>,
	// which BlobPart (File/FormData) rejects. One small copy per render.
	const png = new Uint8Array(await canvas.encode(GRID_COMPRESSION));
	const end = performance.now();

	// Size is worth logging: tiles composite at the local mirror's native resolution (no resize), so
	// re-exporting the mirror at a higher resolution would silently grow every upload toward
	// Discord's attachment limit.
	const elapsed = formatDuration(Math.round(end - start), { ignoreZero: true });
	const composeElapsed = formatDuration(Math.round(end - composeStart), { ignoreZero: true });
	log.debug(
		`deck grid: ${String(tiles.length)} tiles (${String(fallbacks)} from CDN), ${hl.value(formatBytes(png.length))}, in ${elapsed} (compose+encode ${composeElapsed})`
	);

	return png;
}

/**
 * Cached front door for `composeDeckGrid`: the render is deterministic from the deck's ordered
 * mirror filenames — `tileName` already encodes the card as played (id + variant), independent of
 * whether the local file or the CDN served each tile — so identical decks reuse the finished PNG —
 * and a quiet Deploy log means cache hits, not missing renders. A hit refreshes the entry's
 * recency; a miss renders, caches the promise (deduping concurrent renders of the same deck), and
 * evicts the least-recently-used deck past the cap. Throws on an empty deck or a tile load/decode
 * failure — the caller falls back to the text-only message — and failures evict themselves so a bad
 * render isn't cached.
 */
async function renderDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	const key = cards.map((card) => tileName(card)).join("|");
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
	const pending = composeDeckGrid(cards);
	deckCache.set(key, pending);

	try {
		return await pending;
	} catch (error) {
		deckCache.delete(key);
		throw error;
	}
}

export { CELL_HEIGHT, CELL_WIDTH, IMAGES_DIR, renderDeckGrid, scanArtBounds };
