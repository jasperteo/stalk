/**
 * @module
 *
 * Renders a deck as one PNG: the cards in a 4-column grid, resting on a shared baseline.
 *
 * One render goes through these steps:
 *
 * 1. Load each card's art from `images/`, or from the CDN for a card with no file there. Decode it
 *    to raw RGBA and trim the transparent margin from its top and sides.
 * 2. Place each trimmed tile, at its native size, in a cell of fixed size.
 * 3. Composite every tile onto one transparent canvas and encode the result as PNG, in a single
 *    sharp pipeline with no resize.
 *
 * An 8-card deck comes out 1080×794 px and 3.28 MiB. The constants below say where their values come
 * from. `pnpm measure` prints the card-art margins they are based on, and `pnpm preview` renders a
 * sample deck for checking a layout change by eye.
 *
 * Nothing is cached between renders. Deno Deploy stops an idle instance after about 20 to 30 seconds,
 * so with one tick a minute a cache would rarely outlive the tick that filled it. Within a tick, the
 * same deck renders twice only when two tracked players meet or both sides play the same deck, and
 * the second render's file reads come from the OS page cache.
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
 * Sharp's default export, imported on the first render instead of when this module loads. Most
 * ticks post nothing, so most instances never load libvips at all.
 *
 * Two settings apply once sharp loads:
 *
 * - `cache(false)` turns off libvips' operation cache. An instance lives for about one tick and does
 *   not repeat operations, so the cache would only hold memory.
 * - `concurrency(1)` gives each pipeline a single libvips thread. A deck's tiles already decode in
 *   parallel through `Promise.all`, so extra threads inside each pipeline mostly add coordination
 *   work. Measured locally on the `pnpm preview` deck, a render costs about 36 ms of CPU and 13 ms
 *   of wall time with 1 thread, against 59 ms of CPU and 12 ms of wall time with one thread per
 *   core (11). Deno Deploy bills CPU time, and nothing waits on a render's wall time. On glibc
 *   Linux without jemalloc, sharp already defaults to 1; setting it explicitly makes every platform
 *   behave the same, local measurements included.
 *
 * It is a `Lazy` because `Lazy` forgets a rejected load, so a transient failure to load the native
 * addon is retried on the next render. A bare `promise ??= import("sharp")` would keep the
 * rejection and fail every later render on that instance, and `discord.ts` would hide the failure
 * by posting text only. No test catches that swap: failing the import on purpose would mean mocking
 * a native module that the next render needs for real.
 */
const sharpModule = new Lazy(async () => {
	const { default: sharp } = await import("sharp");

	sharp.cache(false);
	sharp.concurrency(1);

	return sharp;
});

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The local card art: `<id>.png` for each card, plus `<id>-evo.png` and `<id>-hero.png` for cards
 * with those forms. Every file is a 285×420 PNG, the same canvas the API's icons use, and the
 * directory ships with each deploy. The URL resolves against this module, not the working
 * directory, so the files are found wherever the process starts.
 *
 * @internal Exported for `scripts/measure.ts`, so it measures the same directory the renderer reads.
 */
const IMAGES_DIR = new URL("../images/", import.meta.url);

/** Cards per row. A full 8-card deck fills two rows. */
const COLUMNS = 4;
/**
 * The width of every cell, in pixels: the widest tile any file in `images/` trims to. `pnpm
 * measure` reports trimmed widths of 257 to 261 px.
 *
 * @internal Exported for tests.
 */
const CELL_WIDTH = 261;
/**
 * The height of every cell, in pixels: the tallest tile any file in `images/` trims to.
 * {@link trimRaw} keeps each icon's bottom edge, so a tile runs from the top of its art to the
 * bottom of the 420 px canvas. The smallest top margin in `images/` is 15 px, which gives 405.
 * `pnpm measure` prints that margin as `top`. Its "trimmed height" measures the art alone, without
 * the bottom padding, and is not this number.
 *
 * Raising either cell dimension only adds empty space around the tiles. Lowering one below the
 * largest tile would let that tile spill out of its cell. Adding art to `images/` means running
 * `pnpm measure` again.
 *
 * @internal Exported for tests.
 */
const CELL_HEIGHT = 405;
/**
 * The horizontal gap between cells, in pixels. Tiles are trimmed on both sides, so this is the
 * visible space between two neighboring cards.
 */
const COLUMN_GAP = 12;
/**
 * The vertical gap between rows, in pixels. It is negative: each row starts 16 px above the bottom
 * of the row above it. Every tile keeps its transparent bottom padding, 17 to 32 px in `images/`,
 * and the overlap uses part of that padding instead of leaving an empty band under the shorter
 * cards.
 *
 * The overlap has to stay smaller than the thinnest bottom padding, or a full-height tile in the
 * lower row would be drawn over the art above it. At -16 it is 1 px inside the 17 px minimum.
 * {@link renderDeckGrid} warns when a tile has less padding than the overlap.
 */
const ROW_GAP = -16;
/**
 * The alpha value at or below which a pixel counts as transparent when finding a card's art bounds.
 * With this threshold, 28 of the icons in `images/` trim 1 or 2 px tighter than with 0, because
 * their faint edge pixels don't count as art. The cell sizes were measured at this threshold, and
 * the widest tile is one of the 28, so changing it means measuring again.
 */
const ALPHA_THRESHOLD = 8;
/** Bytes per pixel in every raw bitmap in this module. {@link decodeToRaw} always yields RGBA. */
const BYTES_PER_PIXEL = 4;
/**
 * The zlib compression level, 0 to 9, for the finished grid's PNG. Level 0 stores the pixels
 * uncompressed. Measured locally on the `pnpm preview` deck:
 *
 * - Level 0: 3.28 MiB, 1.8 ms of CPU per encode.
 * - Level 6: 1.42 MiB, 29.7 ms.
 * - Level 9: 1.40 MiB, 57.9 ms.
 *
 * The PNG is lossless at every level, so the choice only trades upload size against CPU time. Deno
 * Deploy bills CPU time: the free tier's 10 CPU-hours a month come to about 0.8 s per tick. The
 * size has room: a post carries two grids, about 6.6 MiB, against Discord's limits of 20 MiB per
 * file and 25 MiB per request.
 */
const GRID_COMPRESSION = 0;
/**
 * How long a CDN fetch for a card's art may run before it aborts. A hung request would otherwise
 * hold the tick open.
 */
const ICON_TIMEOUT_MS = 10_000;

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/**
 * A decoded bitmap, row-major RGBA with no padding between rows. `data` is a `Buffer` because crops
 * of it go straight to `.composite()`, whose `input` accepts a `Buffer` but not a plain
 * `Uint8Array`.
 */
type RawImage = {
	data: Buffer;
	width: number;
	height: number;
};

/** The opaque region of a bitmap, as inclusive pixel coordinates. */
type Bounds = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
};

/** A rectangle to copy out of a bitmap, in pixels. */
type Region = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * A trimmed card, ready to composite: its pixels from {@link cropRaw}, its size, and the number of
 * transparent rows it kept below the art. {@link renderDeckGrid} checks `bottomPadding` against the
 * row overlap.
 */
type Tile = {
	data: Buffer;
	width: number;
	height: number;
	bottomPadding: number;
};

/** The pixel layout for a number of tiles: the canvas size and the top edge of each row. */
type GridPlan = {
	width: number;
	height: number;
	/** The top edge of each row, in pixels from the top of the canvas. */
	rowTops: number[];
};

// ══════════════════════════════════════════ RAW BITMAPS ══════════════════════════════════════════

/**
 * Decodes an encoded image into a raw RGBA bitmap.
 *
 * The pixels leave sharp through `toBuffer()`, as everywhere in this module. `toUint8Array()`
 * returns the same bytes but first copies them out of libvips' memory, while `toBuffer()` hands
 * that memory over without a copy. `toBuffer()` is also typed `Buffer<ArrayBuffer>`, which `File`
 * and `.composite()` accept; `toUint8Array()` is typed as a plain `Uint8Array`, which neither
 * accepts.
 *
 * @param bytes The encoded image. `Deno.readFile`'s result passes in as it is.
 * @returns A 4-channel bitmap. `ensureAlpha` adds an alpha channel to an opaque source, so every
 *   bitmap has the {@link BYTES_PER_PIXEL} stride that scanning and cropping assume.
 * @internal Exported for `scripts/measure.ts` and tests, so their numbers come from the renderer's
 *   own decoding.
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
 * Finds the bounding box of a bitmap's opaque pixels, those with alpha above
 * {@link ALPHA_THRESHOLD}. It scans rows from the top and from the bottom for `minY` and `maxY`,
 * then columns from the left and from the right, only within those rows, for `minX` and `maxX`.
 * Each scan stops at the first row or column with an opaque pixel, so it reads little more than the
 * margins.
 *
 * @returns The inclusive bounds, or `undefined` for a fully transparent bitmap.
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
 * Copies a rectangle out of a raw RGBA bitmap, one row at a time. A plain memory copy is cheaper
 * than setting up a second sharp pipeline for `.extract()`. The result is a `Buffer`, which is what
 * `.composite()` accepts as `input`.
 *
 * The destination comes from `Buffer.alloc`, which fills it with zeros, not `Buffer.allocUnsafe`.
 * `subarray` silently shortens a range that runs past the end of the source, so an out-of-bounds
 * row would otherwise leave old heap bytes in the output. The bounds check rules that out, and the
 * zero fill still covers a future caller whose region does not come from {@link scanArtBounds}.
 *
 * @returns The cropped pixels, packed at `region.width` pixels per row.
 * @throws When `region` has a negative coordinate or size, or extends past the source bitmap.
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

/** The file in `images/` for a card as it was played: `<id>.png`, `<id>-evo.png` or `<id>-hero.png`. */
function tileName(card: Card) {
	return `${String(card.id)}${evolutionOf(card).suffix}.png`;
}

/**
 * The CDN URL of a card's art in the form it was played. It is only used for a card with no file in
 * `images/`.
 *
 * @throws When the card was played as an Evolution or a Hero but the API lists no icon for that
 *   form. Falling back to the base `medium` art would show the wrong picture with no sign that
 *   anything was wrong. The throw fails the whole render, through {@link loadTile}, so the battle
 *   posts as text only and the error is logged. An ordinary card never throws, since the schema
 *   requires `medium`.
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
 * Trims a decoded icon's transparent margin from the top, left and right, and keeps its bottom
 * edge. Every icon is drawn on the same 285×420 canvas, so keeping the canvas's bottom edge lines
 * the cards up the way the source art places them. Trimming the bottom as well would align each
 * card on its lowest opaque pixel, and a card whose frame reaches lower would then sit higher than
 * its neighbors. The tile keeps its native resolution, since scaling it up would blur it.
 *
 * @returns The trimmed tile, with `bottomPadding` set to the transparent rows kept below the art. A
 *   fully transparent bitmap comes back whole, with `bottomPadding` equal to its height; cropping
 *   it to an empty region would give `.composite()` a zero-size input and fail the render.
 */
function trimRaw(raw: RawImage): Tile {
	const { width, height } = raw;
	const bounds = scanArtBounds(raw);

	// No card art is fully transparent, but a blank tile must not fail the render.
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
 * Decodes an encoded icon and trims it with {@link trimRaw}. This is the path local art takes.
 *
 * @internal Exported for tests.
 */
async function trimToArt(bytes: Uint8Array) {
	return trimRaw(await decodeToRaw(bytes));
}

/**
 * Fetches a card's art from the CDN and prepares it the same way as local art: decode, then trim.
 * Only a trimmed tile that is still larger than a cell is shrunk to fit, keeping its aspect ratio.
 *
 * Trimming comes first because {@link CELL_WIDTH} and {@link CELL_HEIGHT} bound trimmed tiles, not
 * whole canvases. Fitting the untrimmed canvas into the cell would shrink its transparent margin
 * along with the art, and a card that needed no scaling would come out smaller than its local
 * neighbors. CDN icons use the same 285×420 canvas as the local files, so the shrink only runs for
 * art larger than any in `images/` today. It still has to exist, because a tile larger than its
 * cell would spill into its neighbors.
 *
 * @throws When the response is not ok, when the request times out, or when the image fails to
 *   decode.
 */
async function fetchTile(url: string) {
	const response = await fetch(url, {
		headers: { Accept: "image/*" },
		method: "GET",
		signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
	});

	if (!response.ok) {
		// Discard the body so the connection is released rather than held by an unread response.
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

	// The tile is already raw RGBA, so the resize reads and writes raw pixels, with no encode or
	// decode around it. The result goes through `trimRaw` again, which recomputes its bottom padding
	// at the new scale.
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
 * Loads a card's tile: from `images/` when the file exists, from the CDN otherwise. A missing file
 * means the card is newer than the local art, and the warning logged here is the reminder to add
 * it.
 *
 * @returns The trimmed tile.
 * @throws Any error from the local read other than `NotFound`, and any error from the CDN path.
 *   Both fail the whole render.
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
 * The pixel layout for a number of tiles. It touches no pixels, so tests can check it directly. The
 * width is always four cells and three gaps, 1080 px. Each row after the first adds a cell height
 * minus the overlap, so two rows come to 794 px.
 *
 * @param tileCount How many tiles the grid holds. Only the count matters, never the tiles' sizes,
 *   so every deck with the same number of cards gets the same canvas.
 * @internal Exported for tests.
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
 * Renders a deck as a PNG grid of 4 columns. A full 8-card deck fills two rows, and a shorter deck
 * leaves its last cells empty.
 *
 * The tiles load in parallel. The canvas, every overlay and the PNG encode then run as one sharp
 * pipeline with no resize, so the grid ships at its native width of 1080 px.
 *
 * @returns The encoded PNG, about 3.3 MiB for 8 cards.
 * @throws On an empty deck, and when any tile fails to load or decode. `discord.ts` catches the
 *   error and posts the battle as text only. An empty deck happens in
 *   `All_Random_Princess_Friendly` battles; without the throw it would render as a blank 1080×16
 *   strip.
 */
async function renderDeckGrid(cards: Card[]) {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	// Every tile load awaits `sharpModule` inside `decodeToRaw`, so sharp is loaded by the time the
	// tiles resolve and the `get()` below returns straight away.
	const tiles = await Promise.all(cards.map((card) => loadTile(card)));
	const sharp = await sharpModule.get();

	const composeStart = performance.now();
	const { width, height, rowTops } = planGrid(tiles.length);

	// Walking the rows gives each overlay its row's top from the iteration. Indexing `rowTops` by row
	// instead would return `number | undefined` and need a fallback. `slice` stops at the end of the
	// tile list, which is how a short deck leaves its last cells empty.
	const overlays = rowTops.flatMap((cellY, row) =>
		tiles.slice(row * COLUMNS, (row + 1) * COLUMNS).map((tile, column) => {
			// Every row but the last has a row below it that overlaps its bottom by -ROW_GAP px. A
			// tile with less bottom padding than that would have the lower row drawn over its art.
			if (row < rowTops.length - 1 && tile.bottomPadding < -ROW_GAP) {
				log.warn(
					`card art bottom padding ${hl.strong(String(tile.bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
				);
			}

			// Center the tile horizontally and align it to the cell's bottom, so every card rests on
			// the same baseline and a taller tile extends upward.
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
 * @internal Not part of the production path, where `discord.ts` calls only {@link renderDeckGrid}.
 *   Each of these names its consumer in its own JSDoc: `scripts/measure.ts`, tests, or both.
 */
export { CELL_HEIGHT, CELL_WIDTH, decodeToRaw, IMAGES_DIR, planGrid, scanArtBounds, trimToArt };

export type { GridPlan, RawImage };
