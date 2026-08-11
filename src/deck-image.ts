import { Buffer } from "node:buffer";

import { Lazy } from "@std/async/lazy";
import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";
import type { SharpConstructor } from "sharp";

import { hl, log } from "@/log.ts";
import type { Card, EvolutionLevel } from "@/schema.ts";

/**
 * Composites Clash Royale cards into a bottom-aligned 4-column PNG grid via sharp.
 *
 * `docs/deck-rendering.md` is the authority on every constant's value and rationale — benchmarks,
 * size tables, change history. Comments here cover only what a future edit must not silently
 * break.
 */

// ════════════════════════════════════════════ RUNTIME ════════════════════════════════════════════

/**
 * Lazily imports sharp so its native binding loads on first render, not every isolate cold boot.
 * `sharp.cache(false)` disables libvips' own cache: a fresh isolate per tick means it can never
 * accumulate a useful hit, only hold memory, so no cache is wanted here at all.
 * `sharp.concurrency(1)` collapses each pipeline's thread pool to one thread, trading wall time for
 * total CPU — the metric Deploy bills, and nothing here is waiting on wall time.
 *
 * `Lazy` is here for its rejection semantics, not just the memo: it clears its state when the
 * initializer rejects, so the next render retries. Caching the rejection would let one transient
 * dlopen failure silently poison every later render for the isolate's lifetime.
 */
const sharpModule = new Lazy<SharpConstructor>(async () => {
	const { default: sharp } = await import("sharp");

	sharp.cache(false);
	sharp.concurrency(1);

	return sharp;
});

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The local card-art mirror (`<id>.png`, `<id>-evo.png`, `<id>-hero.png`), resolved relative to
 * this module rather than the cwd so it survives Deno Deploy, where the cwd isn't the repo root.
 */
const IMAGES_DIR = new URL("../images/", import.meta.url);

const COLUMNS = 4;
/** Fixed cell size every tile composites into: the upper bound of every icon's trimmed size. */
const CELL_WIDTH = 261;
const CELL_HEIGHT = 405;
/** Gutter between columns, native px. Tiles are trimmed on the sides, so this is the true gap. */
const COLUMN_GAP = 12;
/**
 * Gutter between rows, negative so a row's transparent bottom padding overlaps the row below. Don't
 * go below roughly -20, or hexagon/champion frames start to clip.
 */
const ROW_GAP = -16;
/** Alpha at or below this counts as transparent when scanning for a card's art bounds. */
const ALPHA_THRESHOLD = 8;
/** Stride of the raw bitmaps this module works in — `decodeToRaw` always yields RGBA. */
const BYTES_PER_PIXEL = 4;
/**
 * PNG zlib compressionLevel (0–9) for the shipped grid. 0 trades upload size for encode CPU, the
 * scarcer resource on Deploy.
 */
const GRID_COMPRESSION = 0;
/** Abort a fallback card-icon CDN fetch after this long, so a hung request can't stall the tick. */
const ICON_TIMEOUT_MS = 10_000;

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/** A decoded, row-major RGBA bitmap: the shape `scanArtBounds` walks. */
type RawImage = {
	data: Uint8Array;
	width: number;
	height: number;
};

/** A crop rectangle in raw-bitmap pixel coordinates. */
type Region = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * A trimmed icon ready to composite, plus the transparent bottom margin it kept — `renderDeckGrid`
 * uses that padding to know how far the row below may overlap without clipping. `data` is a
 * `Buffer`, produced by `cropRaw`.
 */
type Tile = {
	data: Buffer;
	width: number;
	height: number;
	bottomPadding: number;
};

/** Pixel geometry for a given tile count: grid size and each row's top. */
type GridPlan = {
	width: number;
	height: number;
	/** Top y of each row, native px. */
	rowTops: number[];
};

// ══════════════════════════════════════════ RAW BITMAPS ══════════════════════════════════════════

/**
 * Decodes an encoded icon to the raw RGBA bitmap `scanArtBounds` walks. Exported for
 * `scripts/measure.ts`, so its margin numbers come from the renderer's own decode.
 */
async function decodeToRaw(bytes: Uint8Array): Promise<RawImage> {
	const sharp = await sharpModule.get();
	const { data, info } = await sharp(bytes).ensureAlpha().raw().toUint8Array();
	return { data, width: info.width, height: info.height };
}

/**
 * Scans a decoded bitmap for its opaque bounding box (alpha above `ALPHA_THRESHOLD`) via four
 * directional scans — row-major top-down/bottom-up for minY/maxY, then column scans restricted to
 * that row range for minX/maxX — rather than visiting every pixel.
 *
 * @returns The opaque bounding box; `maxX === -1` (with `minX === width`, `minY === height`) when
 *   the bitmap is fully transparent — the sentinel callers must handle.
 */
function scanArtBounds({ data, width, height }: RawImage) {
	const rowStride = width * BYTES_PER_PIXEL;

	const rowHasOpaque = (y: number) => {
		for (let x = 0, offset = y * rowStride + 3; x < width; x++, offset += BYTES_PER_PIXEL) {
			if ((data[offset] ?? 0) > ALPHA_THRESHOLD) return true;
		}
		return false;
	};
	const columnHasOpaque = (x: number, minY: number, maxY: number) => {
		for (
			let y = minY, offset = minY * rowStride + x * BYTES_PER_PIXEL + 3;
			y <= maxY;
			y++, offset += rowStride
		) {
			if ((data[offset] ?? 0) > ALPHA_THRESHOLD) return true;
		}
		return false;
	};

	let minY = -1;
	for (let y = 0; y < height; y++) {
		if (rowHasOpaque(y)) {
			minY = y;
			break;
		}
	}

	if (minY < 0) {
		return { minX: width, minY: height, maxX: -1, maxY: -1 };
	}

	let maxY = height - 1;
	for (; maxY > minY; maxY--) {
		if (rowHasOpaque(maxY)) break;
	}

	let minX = 0;
	for (; minX < width; minX++) {
		if (columnHasOpaque(minX, minY, maxY)) break;
	}

	let maxX = width - 1;
	for (; maxX > minX; maxX--) {
		if (columnHasOpaque(maxX, minY, maxY)) break;
	}

	return { minX, minY, maxX, maxY };
}

/**
 * Copies a rectangle out of a raw RGBA bitmap, row by row — a plain memcpy in-process rather than a
 * second `sharp(...).extract()` pipeline. Returns a `Buffer` because `.composite()`'s
 * `OverlayOptions.input` accepts no `Uint8Array` — the `sharp()` constructor does, so this is a
 * `.composite()` constraint, not a sharp-wide one, and it is the only reason `node:buffer` is
 * imported here.
 *
 * Zero-fills via `Buffer.alloc`, not `allocUnsafe`: `subarray` clamps silently on a short row, so
 * an out-of-bounds region would otherwise leave uninitialized heap bytes in the tail of a row
 * instead of failing loudly. The guard below should make that path unreachable, but the zero-fill
 * is cheap insurance against a future caller that doesn't share `scanArtBounds`'s invariants.
 */
function cropRaw({ data, width }: RawImage, region: Region): Buffer {
	if (
		region.left < 0 ||
		region.top < 0 ||
		region.width < 0 ||
		region.height < 0 ||
		region.left + region.width > width ||
		(region.top + region.height) * width * BYTES_PER_PIXEL > data.length
	) {
		throw new Error(
			`Crop region ${String(region.left)},${String(region.top)} ${String(region.width)}x${String(region.height)} exceeds the ${String(width)}px-wide source bitmap`
		);
	}

	const rowBytes = region.width * BYTES_PER_PIXEL;
	const cropped = Buffer.alloc(region.height * rowBytes);

	for (let y = 0; y < region.height; y++) {
		const start = ((region.top + y) * width + region.left) * BYTES_PER_PIXEL;
		cropped.set(data.subarray(start, start + rowBytes), y * rowBytes);
	}

	return cropped;
}

// ═══════════════════════════════════════════ CARD ART ════════════════════════════════════════════

/**
 * Local-art filename suffix per `evolutionLevel` (1 = Evolution, 2 = Hero); ordinary cards use the
 * bare `<id>.png`. The `satisfies` clause makes a new schema level fail to compile here rather than
 * silently fall through to the base art.
 */
const EVOLUTION_SUFFIX = {
	1: "-evo",
	2: "-hero",
} as const satisfies Record<EvolutionLevel, string>;

/**
 * Which `iconUrls` variant each `evolutionLevel` prefers on the CDN-fallback path; guarded like
 * `EVOLUTION_SUFFIX`.
 */
const EVOLUTION_ICON = {
	1: "evolutionMedium",
	2: "heroMedium",
} as const satisfies Record<EvolutionLevel, keyof Card["iconUrls"]>;

/** The local mirror filename for the card as it was played: `<id>`, `<id>-evo`, or `<id>-hero`. */
function tileName(card: Card): string {
	const suffix = card.evolutionLevel ? EVOLUTION_SUFFIX[card.evolutionLevel] : "";
	return `${String(card.id)}${suffix}.png`;
}

/**
 * CDN art URL for the card as played — the fallback when the local mirror has no file yet.
 *
 * Throws when `evolutionLevel` is set but the API lists no matching variant, rather than silently
 * substituting the wrong (un-evolved) art: the throw rejects the whole render, via `loadTile`.
 */
function iconUrl(card: Card): string {
	if (!card.evolutionLevel) {
		return card.iconUrls.medium;
	}

	const key = EVOLUTION_ICON[card.evolutionLevel];
	const variant = card.iconUrls[key];

	if (variant === undefined) {
		throw new Error(
			`card ${String(card.id)} (${card.name}) played at evolutionLevel ${String(card.evolutionLevel)} but the API lists no ${key} icon`
		);
	}

	return variant;
}

// ═════════════════════════════════════════════ TILES ═════════════════════════════════════════════

/**
 * Trims a decoded bitmap's transparent margin on the top and sides but keeps its native bottom
 * edge: every icon shares that baseline, so bottom-aligning on it (`renderDeckGrid`) lines the card
 * frames up. Kept at native resolution, since upscaling would blur.
 */
function trimRaw(raw: RawImage): Tile {
	const { width, height } = raw;
	const { minX, minY, maxX, maxY } = scanArtBounds(raw);

	// Fully-transparent sentinel (shouldn't happen for card art): keep the whole frame.
	if (maxX < 0) {
		return {
			data: cropRaw(raw, { left: 0, top: 0, width, height }),
			width,
			height,
			bottomPadding: height,
		};
	}

	const region = { left: minX, top: minY, width: maxX - minX + 1, height: height - minY };

	return {
		data: cropRaw(raw, region),
		width: region.width,
		height: region.height,
		bottomPadding: height - 1 - maxY,
	};
}

/** Decodes an encoded icon, then trims it — see `trimRaw`. The local-art path's entry point. */
async function trimToArt(bytes: Uint8Array): Promise<Tile> {
	return trimRaw(await decodeToRaw(bytes));
}

/**
 * Fetches a fallback card icon and trims it exactly like a local one, shrinking it only if the
 * _trimmed_ tile still overflows the cell.
 *
 * Trim first, resize second — never the reverse. `CELL_WIDTH`/`CELL_HEIGHT` bound every local
 * icon's **trimmed** size, not its raw canvas: fitting the untrimmed canvas to the cell would scale
 * a tile's transparent margin down together with its art, undersizing it next to its neighbours.
 */
async function fetchTile(url: string): Promise<Tile> {
	const response = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });

	if (!response.ok) {
		// Drain so the connection is released rather than pinned by an unread body.
		await response.body?.cancel();
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	const fetched = new Uint8Array(await response.arrayBuffer());
	const tile = trimRaw(await decodeToRaw(fetched));

	if (tile.width <= CELL_WIDTH && tile.height <= CELL_HEIGHT) {
		return tile;
	}

	log.warn(
		`CDN icon trims to ${hl.strong(`${String(tile.width)}x${String(tile.height)}`)}, past the ${hl.strong(`${String(CELL_WIDTH)}x${String(CELL_HEIGHT)}`)} cell for ${url}; shrinking to fit`
	);

	// Raw in, raw out, like cropRaw: the trimmed tile is already decoded, so encoding here would
	// only buy a deflate pass plus the inflate to undo it.
	const sharp = await sharpModule.get();
	const { data, info } = await sharp(tile.data, {
		raw: { width: tile.width, height: tile.height, channels: BYTES_PER_PIXEL },
	})
		.resize({ width: CELL_WIDTH, height: CELL_HEIGHT, fit: "inside" })
		.raw()
		.toUint8Array();

	return trimRaw({ data, width: info.width, height: info.height });
}

/**
 * Loads a card's tile ready to composite, reading from the local mirror. A `NotFound` means the
 * card released after the last mirror sync: warn (the signal to add its art) and fall back to the
 * CDN icon. `cdnFallback` reports whether that fallback ran so `renderDeckGrid` can log it. Any
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

// ════════════════════════════════════════════ LAYOUT ═════════════════════════════════════════════

/**
 * Pure grid geometry for a given number of tiles: overall size and each row's top. No I/O —
 * isolated from `renderDeckGrid` so it's unit-testable on its own.
 */
function planGrid(tileCount: number): GridPlan {
	const rows = Math.ceil(tileCount / COLUMNS);
	const width = COLUMNS * CELL_WIDTH + (COLUMNS - 1) * COLUMN_GAP;
	const pitch = CELL_HEIGHT + ROW_GAP;

	return {
		width,
		height: (rows - 1) * pitch + CELL_HEIGHT,
		rowTops: Array.from({ length: rows }, (_, row) => row * pitch),
	};
}

// ════════════════════════════════════════════ COMPOSE ════════════════════════════════════════════

/**
 * Renders a deck as a 4-column PNG grid (2 rows for a full 8-card deck); short decks leave trailing
 * cells empty.
 *
 * @throws On an empty deck or a tile load/decode failure; the caller posts the text-only fallback.
 */
async function renderDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	// Not raced against `sharpModule.get()`: every tile load awaits it internally (via
	// `decodeToRaw`), so sharp is already resolved by the time the tiles are and this await comes
	// off the memo.
	const loaded = await Promise.all(cards.map((card) => loadTile(card)));
	const sharp = await sharpModule.get();

	let fallbacks = 0;
	const tiles: Tile[] = [];
	for (const entry of loaded) {
		if (entry.cdnFallback) fallbacks++;
		tiles.push(entry.tile);
	}

	const composeStart = performance.now();
	const { width, height, rowTops } = planGrid(tiles.length);
	const rows = rowTops.length;

	const overlays = tiles.map((tile, index) => {
		const row = Math.floor(index / COLUMNS);

		// Warn on any row but the last: the row below overlaps by ROW_GAP (negative), and this
		// tile's kept bottom padding must cover it or the row below would clip its art.
		if (row < rows - 1 && tile.bottomPadding < -ROW_GAP) {
			log.warn(
				`card art bottom padding ${hl.strong(String(tile.bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
			);
		}

		// Centre horizontally, align to the cell's bottom so every card rests on the shared baseline
		// and taller frames extend upward.
		const cellX = (index % COLUMNS) * (CELL_WIDTH + COLUMN_GAP);
		const cellY = rowTops[row] ?? 0;
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
	// Narrowed, not copied: sharp documents toUint8Array() as returning a transferable, plain
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

export {
	CELL_HEIGHT,
	CELL_WIDTH,
	decodeToRaw,
	IMAGES_DIR,
	planGrid,
	renderDeckGrid,
	scanArtBounds,
	trimToArt,
};
export type { GridPlan, RawImage };
