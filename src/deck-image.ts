/**
 * @module
 *
 * Composites Clash Royale cards into a bottom-aligned 4-column PNG grid via sharp.
 *
 * `docs/deck-rendering.md` is the authority on every constant's value and rationale: benchmarks,
 * size tables, change history. Comments here cover only what a future edit must not silently
 * break.
 */

import { Buffer } from "node:buffer";

import { Lazy } from "@std/async/lazy";
import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";

import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";
import { evolutionOf } from "@/schema.ts";

// ════════════════════════════════════════════ RUNTIME ════════════════════════════════════════════

/**
 * Lazily imports and configures sharp on first render with `cache(false)` and `concurrency(1)`.
 * `Lazy` specifically (not a bare promise memo) for its rejection semantics: it clears its state on
 * a rejected initializer, so a transient dlopen failure doesn't silently poison every later
 * render.
 *
 * @see docs/deck-rendering.md#sharp-runtime-config
 */
const sharpModule = new Lazy(async () => {
	const { default: sharp } = await import("sharp");

	sharp.cache(false);
	sharp.concurrency(1);

	return sharp;
});

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The local card-art mirror (`<id>.png`, `<id>-evo.png`, `<id>-hero.png`), resolved relative to
 * this module rather than the cwd so it survives Deno Deploy, where the cwd isn't the repo root.
 *
 * @internal Exported for `scripts/measure.ts`, so its margin numbers come from the same directory
 *   the renderer reads.
 */
const IMAGES_DIR = new URL("../images/", import.meta.url);

const COLUMNS = 4;
/**
 * Fixed cell size every tile composites into: the upper bound of every icon's trimmed size.
 *
 * @internal Exported for tests only.
 * @see docs/deck-rendering.md#cell-sizing
 */
const CELL_WIDTH = 261;
const CELL_HEIGHT = 405;
/**
 * Gutter between columns, native px. Tiles are trimmed on the sides, so this is the true gap.
 *
 * @see docs/deck-rendering.md#gaps-and-overlap
 */
const COLUMN_GAP = 12;
/**
 * Gutter between rows, negative so a row's transparent bottom padding overlaps the row below. Don't
 * go below roughly -20, or hexagon/champion frames start to clip.
 *
 * @see docs/deck-rendering.md#gaps-and-overlap
 */
const ROW_GAP = -16;
/** Alpha at or below this counts as transparent when scanning for a card's art bounds. */
const ALPHA_THRESHOLD = 8;
/** Stride of the raw bitmaps this module works in. {@link decodeToRaw} always yields RGBA. */
const BYTES_PER_PIXEL = 4;
/**
 * PNG zlib compressionLevel (0–9) for the shipped grid. 0 trades upload size for encode CPU, the
 * scarcer resource on Deploy.
 *
 * @see docs/deck-rendering.md#encoding
 */
const GRID_COMPRESSION = 0;
/** Abort a fallback card-icon CDN fetch after this long, so a hung request can't stall the tick. */
const ICON_TIMEOUT_MS = 10_000;

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/**
 * A decoded, row-major RGBA bitmap: the shape {@link scanArtBounds} walks. `data` is a `Buffer` so
 * {@link cropRaw}'s output composites without a cast. See its doc comment.
 */
type RawImage = {
	data: Buffer;
	width: number;
	height: number;
};

/** An inclusive opaque bounding box in raw-bitmap pixel coordinates. */
type Bounds = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
};

/** A crop rectangle in raw-bitmap pixel coordinates. */
type Region = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * A trimmed icon ready to composite, plus the transparent bottom margin it kept.
 * {@link renderDeckGrid} reads that padding to cap how far the row below can overlap before it
 * clips. `data` is a `Buffer`, produced by {@link cropRaw}.
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
 * Decodes an encoded icon to the raw RGBA bitmap `scanArtBounds` walks.
 *
 * @returns Always 4-channel RGBA. `ensureAlpha` guarantees it even for an opaque source, which is
 *   the `BYTES_PER_PIXEL` stride every scan and crop downstream assumes.
 * @internal Exported for `scripts/measure.ts` and tests, so measured margins come from the
 *   renderer's own decode.
 * @see docs/deck-rendering.md#output-method-tobuffer-vs-touint8array
 */
async function decodeToRaw(bytes: Uint8Array): Promise<RawImage> {
	const sharp = await sharpModule.get();
	const { data, info } = await sharp(bytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

/**
 * Scans a decoded bitmap for its opaque bounding box (alpha above `ALPHA_THRESHOLD`), without
 * visiting every pixel. Runs four directional scans: row-major top-down/bottom-up for minY/maxY,
 * then column scans restricted to that row range for minX/maxX.
 *
 * @returns The opaque bounding box, or `undefined` when the bitmap is fully transparent.
 * @internal Exported for `scripts/measure.ts`.
 */
function scanArtBounds({ data, width, height }: RawImage): Bounds | undefined {
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
		return undefined;
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
 * Copies a rectangle out of a raw RGBA bitmap, row by row. That is a plain memcpy in-process rather
 * than a second `sharp(...).extract()` pipeline. Stays on {@link RawImage}'s `Buffer`, which is also
 * what `.composite()`'s `OverlayOptions.input` declares. The `sharp()` constructor admits typed
 * arrays too, so `Buffer` is the one shape that satisfies both without a cast.
 *
 * Zero-fills via `Buffer.alloc`, not `allocUnsafe`: `subarray` clamps silently on a short row, so
 * an out-of-bounds region would otherwise leave uninitialized heap bytes in the tail of a row
 * instead of failing loudly. The guard below should make that path unreachable, but the zero-fill
 * is cheap insurance against a future caller that doesn't share {@link scanArtBounds}'s
 * guarantees.
 *
 * @returns The cropped pixels, tightly packed at `region.width` stride, with no source-width
 *   padding carried along.
 * @throws When `region` falls outside the source bitmap.
 */
function cropRaw({ data, width }: RawImage, region: Region) {
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

/** The local mirror filename for the card as it was played: `<id>`, `<id>-evo`, or `<id>-hero`. */
function tileName(card: Card) {
	return `${String(card.id)}${evolutionOf(card).suffix}.png`;
}

/**
 * CDN art URL for the card as played. This is the fallback when the local mirror has no file yet,
 * rather than silently substituting the wrong (un-evolved) art.
 *
 * @throws When `evolutionLevel` is set but the API lists no matching variant. An ordinary card
 *   cannot reach the throw, since `medium` is the one `iconUrls` entry the schema requires. The
 *   throw rejects the whole render, via {@link loadTile}.
 */
function iconUrl(card: Card) {
	const { iconKey } = evolutionOf(card);
	const variant = card.iconUrls[iconKey];

	if (variant === undefined) {
		throw new Error(
			`card ${String(card.id)} (${card.name}) played at evolutionLevel ${String(card.evolutionLevel)} but the API lists no ${iconKey} icon`
		);
	}

	return variant;
}

// ═════════════════════════════════════════════ TILES ═════════════════════════════════════════════

/**
 * Trims a decoded bitmap's transparent margin on the top and sides but keeps its native bottom
 * edge: every icon shares that baseline, so bottom-aligning on it ({@link renderDeckGrid}) lines
 * the card frames up. Kept at native resolution, since upscaling would blur.
 *
 * @returns The trimmed tile, carrying the `bottomPadding` {@link renderDeckGrid} checks against the
 *   row overlap. A fully-transparent bitmap keeps the whole frame instead, with `bottomPadding`
 *   equal to its full height.
 */
function trimRaw(raw: RawImage): Tile {
	const { width, height } = raw;
	const bounds = scanArtBounds(raw);

	// Fully transparent (shouldn't happen for card art): keep the whole frame.
	if (bounds === undefined) {
		return {
			data: cropRaw(raw, { left: 0, top: 0, width, height }),
			width,
			height,
			bottomPadding: height,
		};
	}

	const { minX, minY, maxX, maxY } = bounds;
	const region = { left: minX, top: minY, width: maxX - minX + 1, height: height - minY };

	return {
		data: cropRaw(raw, region),
		width: region.width,
		height: region.height,
		bottomPadding: height - 1 - maxY,
	};
}

/**
 * Decodes an encoded icon, then trims it as {@link trimRaw} describes. The local-art path's entry
 * point.
 *
 * @internal Exported for tests only.
 */
async function trimToArt(bytes: Uint8Array) {
	return trimRaw(await decodeToRaw(bytes));
}

/**
 * Fetches a fallback card icon and trims it exactly like a local one, resizing only if the trimmed
 * tile still overflows the cell. Trim before resize, never the reverse.
 *
 * @throws When the CDN response isn't ok.
 * @see docs/deck-rendering.md#cdn-fallback
 */
async function fetchTile(url: string) {
	const response = await fetch(url, {
		headers: { Accept: "image/*" },
		method: "GET",
		signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
	});

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
		.toBuffer({ resolveWithObject: true });

	return trimRaw({ data, width: info.width, height: info.height });
}

/**
 * Loads a card's tile ready to composite, reading from the local mirror. A `NotFound` means the
 * card released after the last mirror sync: warn (the signal to add its art) and fall back to the
 * CDN icon.
 *
 * @returns The trimmed tile, from the local mirror or the CDN fallback.
 * @throws On any error but `NotFound`. A decode failure or a bad CDN response propagates and
 *   rejects the whole render.
 * @see docs/deck-rendering.md#cdn-fallback
 */
async function loadTile(card: Card) {
	try {
		const bytes = await Deno.readFile(new URL(tileName(card), IMAGES_DIR));
		return await trimToArt(bytes);
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			log.warn(
				`no local art for card ${hl.entity(String(card.id))} (${card.name}); falling back to the CDN`
			);
			return fetchTile(iconUrl(card));
		}

		throw error;
	}
}

// ════════════════════════════════════════════ LAYOUT ═════════════════════════════════════════════

/**
 * Pure grid geometry for a given number of tiles: overall size and each row's top. It does no I/O,
 * and stays isolated from {@link renderDeckGrid} so it's unit-testable on its own.
 *
 * @param tileCount How many tiles will be placed; only the count matters, never their sizes, which
 *   is what keeps the grid's dimensions constant across decks.
 * @internal Exported for tests only.
 * @see docs/deck-rendering.md#output-size
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
 * @returns The encoded PNG at native resolution, never scaled.
 * @throws On an empty deck or a tile load/decode failure; the caller posts the text-only fallback.
 * @see docs/deck-rendering.md#output-size
 * @see docs/deck-rendering.md#no-cache
 * @see docs/deck-rendering.md#output-method-tobuffer-vs-touint8array
 */
async function renderDeckGrid(cards: Card[]) {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	// Not raced against `sharpModule.get()`: every tile load already awaits it internally (via
	// `decodeToRaw`), so by the time the tiles resolve, sharp is already loaded and this await just
	// returns the cached promise.
	const tiles = await Promise.all(cards.map((card) => loadTile(card)));
	const sharp = await sharpModule.get();

	const composeStart = performance.now();
	const { width, height, rowTops } = planGrid(tiles.length);

	// Walked a row at a time rather than over the flat tile list, so `cellY` comes from the iteration
	// rather than a `rowTops[row]` lookup, which would need a nullish fallback whose only plausible
	// value (0) is itself a real row position. `slice` clamps on the last row, which is what leaves a
	// short deck's trailing cells empty.
	const overlays = rowTops.flatMap((cellY, row) =>
		tiles.slice(row * COLUMNS, (row + 1) * COLUMNS).map((tile, column) => {
			// Warn on any row but the last: the row below overlaps by ROW_GAP (negative), and this
			// tile's kept bottom padding must cover it or the row below would clip its art.
			if (row < rowTops.length - 1 && tile.bottomPadding < -ROW_GAP) {
				log.warn(
					`card art bottom padding ${hl.strong(String(tile.bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
				);
			}

			// Centre horizontally, align to the cell's bottom so every card rests on the shared
			// baseline and taller frames extend upward.
			const cellX = column * (CELL_WIDTH + COLUMN_GAP);
			const left = cellX + Math.floor((CELL_WIDTH - tile.width) / 2);
			const top = cellY + (CELL_HEIGHT - tile.height);

			return {
				input: tile.data,
				raw: { width: tile.width, height: tile.height, channels: 4 as const },
				left,
				top,
			};
		})
	);

	const png = await sharp({
		create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.composite(overlays)
		.png({ compressionLevel: GRID_COMPRESSION })
		.toBuffer();
	const end = performance.now();

	const elapsed = formatDuration(Math.round(end - start), { ignoreZero: true });
	const composeElapsed = formatDuration(Math.round(end - composeStart), { ignoreZero: true });
	log.debug(
		`deck grid: ${String(tiles.length)} tiles, ${hl.value(formatBytes(png.length))}, in ${elapsed} (compose+encode ${composeElapsed})`
	);

	return png;
}

export { renderDeckGrid };

/**
 * @internal Outside the production path. `renderDeckGrid` above is the only export `discord.ts`
 *   calls. Each declaration names its own consumer (`scripts/measure.ts`, tests, or both).
 */
export { CELL_HEIGHT, CELL_WIDTH, decodeToRaw, IMAGES_DIR, planGrid, scanArtBounds, trimToArt };

export type { GridPlan, RawImage };
