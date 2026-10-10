/**
 * @module
 *
 * Renders a deck as one PNG: the cards in a 4-column grid, resting on a shared baseline.
 *
 * The work is split between build time and runtime:
 *
 * - **Build time.** `pnpm tiles` (`scripts/tiles.ts`) decodes every PNG in `images/`, trims its
 *   transparent margin from the top and sides, and writes the result to `tiles/` as a `.tile` file: a short header and the raw RGBA pixels, in the format `tile.ts` documents. It
 *   runs locally before `pnpm start` and `pnpm preview`, and on Deno Deploy as the build step.
 * - **Runtime.** A render reads each card's `.tile` file, places each tile at its native size in a
 *   cell of fixed size, and composites them straight into PNG scanlines: one zero filter byte, then
 *   the row's RGBA bytes. `png.ts` wraps those scanlines in a PNG with a level-0 deflate, which
 *   stores them uncompressed.
 *
 * Decoding is the expensive part of preparing card art, so it happens once per build rather than on
 * every render. Measured locally on the `pnpm preview` deck, a render costs about 2.3 ms of CPU, tile
 * reads included. Decoding and trimming the eight PNGs at render time instead measured about 34 ms,
 * even with a native image library. The runtime path loads no native addon, so it can move to a
 * platform without one, such as Cloudflare Workers.
 *
 * A card with no `.tile` file, one newer than the local art, falls back to the CDN. Its PNG is
 * decoded with fast-png (through `decodePng`), trimmed the same way, and shrunk only if it is still
 * larger than a cell.
 *
 * An 8-card deck comes out 1080×794 px and about 3.3 MiB. The constants below say where their values
 * come from. `pnpm tiles` checks every tile against them, and `pnpm preview` renders a sample deck
 * for checking a layout change by eye.
 *
 * Nothing is cached between renders. Deno Deploy stops an idle instance after about 20 to 30 seconds,
 * so with one tick a minute a cache would rarely outlive the tick that filled it. Within a tick, the
 * same deck renders twice only when two tracked players meet or both sides play the same deck, and
 * the second render's file reads come from the OS page cache.
 */

import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";

import { hl, log } from "@/log.ts";
import { decodePng, encodePng } from "@/png.ts";
import type { Card } from "@/schema.ts";
import { evolutionOf } from "@/schema.ts";
import type { Tile } from "@/tile.ts";
import { BYTES_PER_PIXEL, parseTile, shrinkToFit, trimRaw } from "@/tile.ts";

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The pre-trimmed card art: `<id>.tile` for each card, plus `<id>-evo.tile` and `<id>-hero.tile`
 * for cards with those forms. `pnpm tiles` generates the directory from `images/`, locally and on
 * Deno Deploy through `deploy.build`, and it is gitignored. The URL resolves against this module,
 * not the working directory, so the files are found wherever the process starts.
 *
 * @internal Exported for `scripts/tiles.ts`, so it writes the directory the renderer reads.
 */
const TILES_DIR = new URL("../tiles/", import.meta.url);

/** Cards per row. A full 8-card deck fills two rows. */
const COLUMNS = 4;
/**
 * The width of every cell, in pixels: the widest tile any file in `images/` trims to, 257 to 261
 * px.
 *
 * @internal Exported for `scripts/tiles.ts` and tests.
 */
const CELL_WIDTH = 261;
/**
 * The height of every cell, in pixels: the tallest tile any file in `images/` trims to.
 * {@link trimRaw} keeps each icon's bottom edge, so a tile runs from the top of its art to the
 * bottom of the 420 px canvas. The smallest top margin in `images/` is 15 px, which gives 405.
 *
 * Raising either cell dimension only adds empty space around the tiles. Lowering one below the
 * largest tile would let that tile spill out of its cell, so {@link compositeScanlines} rejects such
 * a tile. `pnpm tiles` fails the build when a tile from `images/` exceeds a cell, so new art that
 * does not fit is caught before it deploys.
 *
 * @internal Exported for `scripts/tiles.ts` and tests.
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
 * lower row would be drawn over the art above it. At -16 it is 1 px inside the 17 px minimum. `pnpm
 * tiles` fails the build when a tile keeps less padding than the overlap, and
 * {@link compositeScanlines} warns when one reaches a render anyway, such as from the CDN.
 *
 * @internal Exported for `scripts/tiles.ts`.
 */
const ROW_GAP = -16;
/**
 * How long a CDN fetch for a card's art may run before it aborts. A hung request would otherwise
 * hold the tick open.
 */
const ICON_TIMEOUT_MS = 10_000;

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/** The pixel layout for a number of tiles: the canvas size and the top edge of each row. */
type GridPlan = {
	width: number;
	height: number;
	/** The top edge of each row, in pixels from the top of the canvas. */
	rowTops: number[];
};

// ═══════════════════════════════════════════ CARD ART ════════════════════════════════════════════

/**
 * The file in `tiles/` for a card as it was played: `<id>.tile`, `<id>-evo.tile` or
 * `<id>-hero.tile`.
 */
function tileName(card: Card) {
	return `${String(card.id)}${evolutionOf(card).suffix}.tile`;
}

/**
 * The CDN URL of a card's art in the form it was played. It is only used for a card with no file in
 * `tiles/`.
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
 * Fetches a card's art from the CDN and prepares it the way `pnpm tiles` prepares local art:
 * decode, then trim. Only a trimmed tile that is still larger than a cell is shrunk to fit, keeping
 * its aspect ratio.
 *
 * Trimming comes first because {@link CELL_WIDTH} and {@link CELL_HEIGHT} bound trimmed tiles, not
 * whole canvases. Fitting the untrimmed canvas into the cell would shrink its transparent margin
 * along with the art, and a card that needed no scaling would come out smaller than its local
 * neighbors. CDN icons use the same 285×420 canvas as the local files, so the shrink only runs for
 * art larger than any in `images/` today. It still has to exist, because {@link compositeScanlines}
 * rejects a tile larger than its cell.
 *
 * The request asks for `image/png` only, because {@link decodePng} reads nothing else.
 *
 * @throws When the response is not ok, when the request times out, or when the image fails to
 *   decode.
 */
async function fetchTile(url: string) {
	const response = await fetch(url, {
		headers: { Accept: "image/png" },
		method: "GET",
		signal: AbortSignal.timeout(ICON_TIMEOUT_MS),
	});

	if (!response.ok) {
		// Discard the body so the connection is released rather than held by an unread response.
		await response.body?.cancel();
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	const tile = trimRaw(decodePng(new Uint8Array(await response.arrayBuffer())));

	if (tile.width <= CELL_WIDTH && tile.height <= CELL_HEIGHT) {
		return tile;
	}

	log.warn(
		`CDN icon trims to ${hl.strong(`${String(tile.width)}x${String(tile.height)}`)}, past the ${hl.strong(`${String(CELL_WIDTH)}x${String(CELL_HEIGHT)}`)} cell for ${url}; shrinking to fit`
	);

	// Shrinking moves the art's edges, so the result goes through `trimRaw` again, which also
	// recomputes its bottom padding at the new scale.
	return trimRaw(shrinkToFit(tile, CELL_WIDTH, CELL_HEIGHT));
}

/**
 * Loads a card's tile: from `tiles/` when the file exists, from the CDN otherwise. A missing file
 * means the card is newer than the local art, and the warning logged here is the reminder to add it
 * to `images/`.
 *
 * @returns The trimmed tile.
 * @throws Any error from the local read other than `NotFound`, including a corrupt file that
 *   {@link parseTile} rejects, and any error from the CDN path. Each fails the whole render.
 */
async function loadTile(card: Card) {
	try {
		return parseTile(await Deno.readFile(new URL(tileName(card), TILES_DIR)));
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
 * Blends one RGBA pixel of `src` over the pixel of `dst`, in place, with unpremultiplied
 * source-over: a transparent source pixel leaves the destination as it is, an opaque one or one
 * over a transparent destination is copied, and anything else uses the standard formula, rounded.
 *
 * @param d The byte offset of the destination pixel.
 * @param s The byte offset of the source pixel.
 */
function blendOver(dst: Uint8Array, d: number, src: Uint8Array, s: number) {
	const srcAlpha = src[s + 3] ?? 0;

	if (srcAlpha === 0) return;

	const dstAlpha = dst[d + 3] ?? 0;

	if (srcAlpha === 255 || dstAlpha === 0) {
		dst[d] = src[s] ?? 0;
		dst[d + 1] = src[s + 1] ?? 0;
		dst[d + 2] = src[s + 2] ?? 0;
		dst[d + 3] = srcAlpha;
		return;
	}

	// Source-over in 255² units: the destination contributes dstAlpha * (1 - srcAlpha).
	const dstWeight = dstAlpha * (255 - srcAlpha);
	const outAlpha = srcAlpha * 255 + dstWeight;

	for (let c = 0; c < 3; c++) {
		dst[d + c] = Math.round(
			((src[s + c] ?? 0) * srcAlpha * 255 + (dst[d + c] ?? 0) * dstWeight) / outAlpha
		);
	}
	dst[d + 3] = Math.round(outAlpha / 255);
}

/**
 * Composites tiles into the PNG scanlines of one transparent canvas laid out by `plan`.
 *
 * The buffer holds `plan.height` rows of one filter byte and `plan.width * 4` RGBA bytes. A new
 * `Uint8Array` is all zeros, which already means filter type 0 (none) on every row and a
 * transparent pixel everywhere, so the result goes to {@link encodePng} as it is.
 *
 * Each tile is centered horizontally and aligned to its cell's bottom, so every card rests on the
 * same baseline and a taller tile extends upward. Its rows are copied with `.set()`, except where
 * they overlap the tile above, which are blended with {@link blendOver}. The overlap needs no
 * tracking, because tiles are drawn in deck order and every tile ends at its cell's bottom. A tile
 * below row 0 therefore always has a tile above it in its column, and the canvas rows already
 * written there end at the bottom of that cell, `cellY - ROW_GAP - 1`, since the row pitch is
 * {@link CELL_HEIGHT} plus {@link ROW_GAP}. A tile row at or above that line is blended, and any
 * row below it lands on transparent pixels and is copied. On row 0 nothing is written yet, so every
 * row is copied.
 *
 * @throws When a tile is wider than {@link CELL_WIDTH} or taller than {@link CELL_HEIGHT}. Rows are
 *   copied without clipping, so an oversized tile in the last column would run into the next row's
 *   filter byte and silently corrupt the PNG. `pnpm tiles` and {@link fetchTile} keep every tile
 *   inside a cell, so this only catches a stale or hand-edited `.tile` file.
 * @internal Exported for tests.
 */
function compositeScanlines(tiles: Tile[], plan: GridPlan) {
	const { width, height, rowTops } = plan;
	const stride = width * BYTES_PER_PIXEL + 1;
	const scanlines = new Uint8Array(stride * height);

	// Walking the rows gives each tile its row's top from the iteration. Indexing `rowTops` by row
	// instead would return `number | undefined` and need a fallback. `slice` stops at the end of the
	// tile list, which is how a short deck leaves its last cells empty.
	rowTops.forEach((cellY, row) => {
		// The last canvas row the tile above has written in any column.
		const writtenTo = cellY - ROW_GAP - 1;

		tiles.slice(row * COLUMNS, (row + 1) * COLUMNS).forEach((tile, column) => {
			if (tile.width > CELL_WIDTH || tile.height > CELL_HEIGHT) {
				throw new Error(
					`Tile ${String(tile.width)}x${String(tile.height)} exceeds the ${String(CELL_WIDTH)}x${String(CELL_HEIGHT)} cell`
				);
			}

			// The tile below in the same column, if the deck has one, overlaps this tile's bottom by
			// -ROW_GAP px. A tile with less bottom padding than that would have it drawn over its art.
			const hasTileBelow = (row + 1) * COLUMNS + column < tiles.length;

			if (hasTileBelow && tile.bottomPadding < -ROW_GAP) {
				log.warn(
					`card art bottom padding ${hl.strong(String(tile.bottomPadding))}px < row overlap ${hl.strong(String(-ROW_GAP))}px; grid rows may clip`
				);
			}

			const left = column * (CELL_WIDTH + COLUMN_GAP) + Math.floor((CELL_WIDTH - tile.width) / 2);
			const top = cellY + (CELL_HEIGHT - tile.height);
			const rowBytes = tile.width * BYTES_PER_PIXEL;
			const src = tile.data;

			for (let y = 0; y < tile.height; y++) {
				const canvasY = top + y;
				const dst = canvasY * stride + 1 + left * BYTES_PER_PIXEL;
				const srcRow = y * rowBytes;

				if (row === 0 || canvasY > writtenTo) {
					scanlines.set(src.subarray(srcRow, srcRow + rowBytes), dst);
					continue;
				}

				for (let x = 0; x < rowBytes; x += BYTES_PER_PIXEL) {
					blendOver(scanlines, dst + x, src, srcRow + x);
				}
			}
		});
	});

	return scanlines;
}

/**
 * Renders a deck as a PNG grid of 4 columns. A full 8-card deck fills two rows, and a shorter deck
 * leaves its last cells empty.
 *
 * The tiles load in parallel. They are then composited into scanlines with
 * {@link compositeScanlines} and wrapped as a PNG with no resize, so the grid ships at its native
 * width of 1080 px.
 *
 * @returns The encoded PNG, about 3.3 MiB for 8 cards.
 * @throws On an empty deck, and when any tile fails to load, parse, decode or fit its cell.
 *   `discord.ts` catches the error and posts the battle as text only. An empty deck happens in
 *   `All_Random_Princess_Friendly` battles; without the throw it would render as a blank 1080×16
 *   strip.
 */
async function renderDeckGrid(cards: Card[]) {
	if (cards.length === 0) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	const tiles = await Promise.all(cards.map((card) => loadTile(card)));

	const composeStart = performance.now();
	const plan = planGrid(tiles.length);
	const png = encodePng(compositeScanlines(tiles, plan), plan.width, plan.height);
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
 *   Each of these names its consumer in its own JSDoc: `scripts/tiles.ts`, tests, or both.
 */
export { CELL_HEIGHT, CELL_WIDTH, compositeScanlines, planGrid, ROW_GAP, TILES_DIR };
