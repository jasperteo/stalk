import { Buffer } from "node:buffer";

import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";
import type { SharpConstructor } from "sharp";

import { config } from "@/env.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * Imported lazily so its codec native binding loads on the first render rather than at every
 * isolate cold boot, and memoized so subsequent renders reuse the resolved module.
 * `sharp.cache(false)` disables libvips' own operation cache — the deck LRU is the only cache we
 * want; libvips' would just hold memory.
 *
 * Only success is memoized: a failed load clears the slot so the next render retries. Caching the
 * rejection instead would let one transient dlopen failure poison every later render for the
 * isolate's lifetime, and silently — `discord.ts` catches a failed render and posts the text-only
 * fallback, so the symptom would be decks quietly vanishing from every post.
 */
let sharpModule: Promise<SharpConstructor> | undefined;

const loadSharp = () =>
	(sharpModule ??= import("sharp").then(
		({ default: sharp }) => {
			sharp.cache(false);
			return sharp;
		},
		(error: unknown) => {
			sharpModule = undefined;
			throw error;
		}
	));

/**
 * The local card-art mirror (`<id>.png`, `<id>-evo.png`, `<id>-hero.png`), resolved relative to
 * this module rather than the cwd so it survives Deno Deploy, where the cwd isn't the repo root.
 */
const IMAGES_DIR = new URL("../images/", import.meta.url);

const COLUMNS = 4;
/**
 * Fixed cell size every tile composites into, so the grid's pixel dimensions stay constant across
 * decks. Set to the upper bound of every local icon's trimmed size (`deno task measure`).
 */
const CELL_WIDTH = 261;
const CELL_HEIGHT = 405;
/**
 * Gutter between columns, in native pixels. Tiles are trimmed on the sides, so this is the true
 * gap.
 */
const COLUMN_GAP = 12;
/**
 * Gutter between rows. Negative so the upper row's transparent bottom padding overlaps the row
 * below, tightening them. Don't go below roughly -20, or hexagon/champion frames start to clip.
 */
const ROW_GAP = -16;
/** Alpha at or below this counts as transparent when scanning for a card's art bounds. */
const ALPHA_THRESHOLD = 8;
/**
 * Stride of the raw bitmaps this module works in. `decodeToRaw`'s `.ensureAlpha().raw()` always
 * yields RGBA — `.raw()` converts to sRGB first, so even a greyscale source decodes to 4 channels.
 */
const BYTES_PER_PIXEL = 4;
/**
 * PNG zlib compressionLevel (0–9) for the shipped grid; lossless, trading encode CPU for upload
 * size.
 */
const GRID_COMPRESSION = 6;
/**
 * Abort a fallback card-icon CDN fetch after this long, so a hung request can't stall the cron
 * tick.
 */
const ICON_TIMEOUT_MS = 10_000;
/**
 * How many finished grids the LRU keeps, sized from the live target count so growing TARGETS keeps
 * each tracked player's decks warm plus headroom for one-shot opponent decks.
 */
const DECK_CACHE_LIMIT = 3 * (config?.targets.length ?? 0) + 10;

/** A decoded, row-major RGBA bitmap: the shape `scanArtBounds` walks. */
type RawImage = {
	data: Uint8Array;
	width: number;
	height: number;
};

/**
 * A trimmed icon ready to composite, plus the transparent bottom margin it kept — the compose layer
 * uses that padding to know how far the row below may overlap without clipping. `data` is a
 * `Buffer` (allocated by `cropRaw`) so it feeds straight into `OverlayOptions.input` without a
 * cast; it never leaves this module.
 */
type Tile = {
	data: Buffer;
	width: number;
	height: number;
	bottomPadding: number;
};

/**
 * Finished grids keyed by the deck's ordered mirror filenames, so a repeated deck skips the render.
 * The only cache here — per-tile reads are covered by the OS page cache. A small LRU: hits
 * re-insert at the back, inserts evict from the front. The cached bytes are shared across posts —
 * safe because callers only wrap them in a `File`, never mutate them.
 */
const deckCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * Local-art filename suffix per `evolutionLevel` (1 = Evolution, 2 = Hero); ordinary cards use the
 * bare `<id>.png`. The `satisfies` clause makes a new schema level fail to compile here rather than
 * silently fall through to the base art.
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
 * Which `iconUrls` variant each `evolutionLevel` prefers on the CDN-fallback path; guarded like
 * `EVOLUTION_SUFFIX`.
 */
const EVOLUTION_ICON = {
	1: "evolutionMedium",
	2: "heroMedium",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, keyof Card["iconUrls"]>;

/**
 * CDN art URL for the card as played — the fallback when the local mirror has no file yet. Prefers
 * the evo/hero variant, falling back to the always-present `medium` so it never resolves blank.
 */
function iconUrl(card: Card): string {
	const variant = card.evolutionLevel
		? card.iconUrls[EVOLUTION_ICON[card.evolutionLevel]]
		: undefined;
	return variant ?? card.iconUrls.medium;
}

/**
 * Scans a decoded bitmap for its opaque pixels (alpha above `ALPHA_THRESHOLD`). Walks the raw RGBA
 * byte array directly (alpha is byte 3 of each quad) to avoid per-pixel accessor overhead.
 *
 * @returns The opaque bounding box; `maxX === -1` when the bitmap is fully transparent — the
 *   sentinel callers must handle.
 */
function scanArtBounds({ data, width, height }: RawImage) {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	let offset = 3;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++, offset += BYTES_PER_PIXEL) {
			if ((data[offset] ?? 0) > ALPHA_THRESHOLD) {
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
 * Decodes an encoded icon to the raw RGBA bitmap `scanArtBounds` walks. Exported for
 * `scripts/measure.ts`, so its margin numbers come from the renderer's own decode rather than a
 * copy that could drift.
 */
async function decodeToRaw(bytes: Uint8Array): Promise<RawImage> {
	const sharp = await loadSharp();
	const { data, info } = await sharp(bytes).ensureAlpha().raw().toUint8Array();
	return { data, width: info.width, height: info.height };
}

/** A crop rectangle in raw-bitmap pixel coordinates. */
type Region = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * Copies a rectangle out of a raw RGBA bitmap, row by row. Doing this in-process rather than
 * through a second `sharp(...).extract()` pipeline keeps the crop a plain memcpy: the decoded bytes
 * are already in JS memory, so a round-trip into libvips and back would just add a native call plus
 * two buffer copies per tile. Returns a `Buffer` so it feeds `OverlayOptions.input` without a
 * cast.
 */
function cropRaw({ data, width }: RawImage, region: Region): Buffer {
	const rowBytes = region.width * BYTES_PER_PIXEL;
	const cropped = Buffer.allocUnsafe(region.height * rowBytes);

	for (let y = 0; y < region.height; y++) {
		const start = ((region.top + y) * width + region.left) * BYTES_PER_PIXEL;
		cropped.set(data.subarray(start, start + rowBytes), y * rowBytes);
	}

	return cropped;
}

/**
 * Decodes an encoded icon and trims its transparent margin on the top and sides but keeps its
 * native bottom edge: every icon shares that baseline, so bottom-aligning on it (see
 * `composeDeckGrid`) lines the card frames up. Kept at native resolution, since upscaling would
 * blur.
 *
 * Decodes once to raw RGBA, scans the art bounds, then slices the region straight out of that
 * bitmap — the trimmed `bottomPadding` is the transparent band the compose layer lets the row below
 * overlap into.
 */
async function trimToArt(bytes: Uint8Array): Promise<Tile> {
	const raw = await decodeToRaw(bytes);
	const { width, height } = raw;
	const { minX, minY, maxX, maxY } = scanArtBounds(raw);

	// One derivation owns both the crop region and the kept bottom padding; the fully-transparent
	// sentinel (shouldn't happen for card art) keeps the whole frame rather than crop to nothing.
	const { region, bottomPadding } =
		maxX < 0
			? { region: { left: 0, top: 0, width, height }, bottomPadding: height }
			: {
					region: { left: minX, top: minY, width: maxX - minX + 1, height: height - minY },
					bottomPadding: height - 1 - maxY,
				};

	return {
		data: cropRaw(raw, region),
		width: region.width,
		height: region.height,
		bottomPadding,
	};
}

async function fetchTile(url: string): Promise<Tile> {
	const response = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });

	if (!response.ok) {
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	return trimToArt(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Loads a card's tile ready to composite, reading from the local mirror. A `NotFound` means the
 * card released after the last mirror sync: warn (the signal to add its art) and fall back to the
 * CDN icon. `cdnFallback` reports whether that fallback ran so `composeDeckGrid` can log it. Any
 * other fetch/decode error propagates and rejects the render.
 */
async function loadTile(card: Card): Promise<{ tile: Tile; cdnFallback: boolean }> {
	try {
		const bytes = await Deno.readFile(new URL(tileName(card), IMAGES_DIR));
		return { tile: await trimToArt(bytes), cdnFallback: false };
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
 * The uncached render behind `renderDeckGrid`, run on a cache miss; short decks leave trailing
 * cells empty.
 */
async function composeDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	// Not raced against `loadSharp()`: every tile load awaits it internally (via `decodeToRaw`), so
	// sharp is already resolved by the time the tiles are and this await comes off the memo.
	const loaded = await Promise.all(cards.map((card) => loadTile(card)));
	const sharp = await loadSharp();
	const fallbacks = loaded.filter((entry) => entry.cdnFallback).length;
	const tiles = loaded.map((entry) => entry.tile);

	const composeStart = performance.now();
	const rows = Math.ceil(tiles.length / COLUMNS);
	const width = COLUMNS * CELL_WIDTH + (COLUMNS - 1) * COLUMN_GAP;
	const height = rows * CELL_HEIGHT + (rows - 1) * ROW_GAP;

	const overlays = tiles.map((tile, index) => {
		const row = Math.floor(index / COLUMNS);

		// Warn when a tile's kept bottom padding can't cover the ROW_GAP overlap and the row below
		// would clip into its art. Bottom-row tiles have no row below.
		if (row < rows - 1 && tile.bottomPadding < -ROW_GAP) {
			log.warn(
				`card art bottom padding ${hl.strong(String(tile.bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
			);
		}

		// Centre horizontally, align to the cell's bottom so every card rests on the shared baseline
		// and taller frames extend upward.
		const cellX = (index % COLUMNS) * (CELL_WIDTH + COLUMN_GAP);
		const cellY = row * (CELL_HEIGHT + ROW_GAP);
		const left = cellX + Math.floor((CELL_WIDTH - tile.width) / 2);
		const top = cellY + (CELL_HEIGHT - tile.height);

		return {
			input: tile.data,
			raw: { width: tile.width, height: tile.height, channels: 4 as const },
			left,
			top,
		};
	});

	const { data } = await sharp({
		create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.composite(overlays)
		.png({ compressionLevel: GRID_COMPRESSION })
		.toUint8Array();
	// Narrowed, not copied: sharp 0.35 documents toUint8Array() as returning a transferable, plain
	// ArrayBuffer — only the declared type is the wider Uint8Array<ArrayBufferLike> that BlobPart
	// (File/FormData) rejects. Copying a grid-sized PNG per render to satisfy the type isn't worth it.
	const png = data as Uint8Array<ArrayBuffer>;
	const end = performance.now();

	const elapsed = formatDuration(Math.round(end - start), { ignoreZero: true });
	const composeElapsed = formatDuration(Math.round(end - composeStart), { ignoreZero: true });
	log.debug(
		`deck grid: ${String(tiles.length)} tiles (${String(fallbacks)} from CDN), ${hl.value(formatBytes(png.length))}, in ${elapsed} (compose+encode ${composeElapsed})`
	);

	return png;
}

/**
 * Renders a deck as a 4-column PNG grid (2 rows for a full 8-card deck), cached: the result is
 * deterministic from the deck's ordered mirror filenames, so identical decks reuse the finished
 * PNG. A hit refreshes recency; a miss renders, caches the promise, and evicts the
 * least-recently-used deck past the cap.
 *
 * @throws On an empty deck or a tile load/decode failure; the caller posts the text-only fallback.
 *   A failed render evicts itself so it isn't cached.
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

export { CELL_HEIGHT, CELL_WIDTH, decodeToRaw, IMAGES_DIR, renderDeckGrid, scanArtBounds };
export type { RawImage };
