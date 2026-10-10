/**
 * @module
 *
 * Builds the card tiles the renderer composites: for every PNG in `images/`, it decodes the art with
 * {@link decodePng}, trims it with {@link trimRaw}, and writes `tiles/<name>.tile` in the format of
 * {@link serializeTile}. The renderer reads only those files, never `images/`, so it decodes no PNG
 * at runtime except CDN art for a card with no tile, through the same `decodePng`.
 *
 * fast-png is pure JavaScript, so the build loads no native addon, the same as the runtime, and the
 * deploy installs production dependencies only. Decoding all 182 files takes about 0.6 s locally.
 *
 * `tiles/` is generated and git ignores it. Deno Deploy runs this script as `deploy.build` in
 * `deno.jsonc` on every deploy, and `pnpm start` and `pnpm preview` run it first, so a tile is
 * never stale. The directory is wiped and rebuilt on each run, so art deleted from `images/` leaves
 * no tile behind. Adding art to `images/` only needs `pnpm tiles` again. It never touches the
 * network.
 *
 * The run ends with one line of ranges, each next to the constant it is checked against, and it
 * fails the build, with a non-zero exit code, when a tile does not fit the renderer: wider than
 * `CELL_WIDTH`, taller than `CELL_HEIGHT`, or with less bottom padding than the `ROW_GAP` overlap
 * needs. That check replaces measuring the art by hand and comparing it against the constants in
 * `src/deck-image.ts`. `pnpm tiles --verbose` also prints each icon's margins, for choosing new
 * values for those constants.
 */

import { CELL_HEIGHT, CELL_WIDTH, ROW_GAP, TILES_DIR } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
import { decodePng } from "@/png.ts";
import type { Tile } from "@/tile.ts";
import { scanArtBounds, serializeTile, trimRaw } from "@/tile.ts";

/** The card art, one PNG per card, variant or hero: `<id>.png`, `<id>-evo.png`, `<id>-hero.png`. */
const IMAGES_DIR = new URL("../images/", import.meta.url);

/** One icon's tile, with the margins the trim removed and the bytes written for it. */
type Built = {
	name: string;
	/** The size of the source PNG's canvas. */
	canvasWidth: number;
	canvasHeight: number;
	tile: Tile;
	/** Transparent columns left of the art. Trimming removes them. */
	left: number;
	/** Transparent columns right of the art. Trimming removes them. */
	right: number;
	/** Transparent rows above the art. Trimming removes them. */
	top: number;
	/** The size of the `.tile` file. */
	bytes: number;
};

/**
 * Decodes `images/<name>.png`, trims it, and writes `tiles/<name>.tile`.
 *
 * @throws When the icon is fully transparent, which would mean a broken file in `images/`.
 */
async function buildTile(name: string): Promise<Built> {
	const png = await Deno.readFile(new URL(`${name}.png`, IMAGES_DIR));
	const raw = decodePng(png);
	const bounds = scanArtBounds(raw);

	if (bounds === undefined) {
		throw new Error(`${name} is fully transparent`);
	}

	const tile = trimRaw(raw);
	const bytes = serializeTile(tile);

	await Deno.writeFile(new URL(`${name}.tile`, TILES_DIR), bytes);

	return {
		name,
		canvasWidth: raw.width,
		canvasHeight: raw.height,
		tile,
		left: bounds.minX,
		right: raw.width - 1 - bounds.maxX,
		top: bounds.minY,
		bytes: bytes.length,
	};
}

/** The name of every PNG in `images/`, without the extension, in sorted order. */
async function listImages() {
	const names: string[] = [];

	for await (const entry of Deno.readDir(IMAGES_DIR)) {
		if (entry.isFile && entry.name.endsWith(".png")) {
			names.push(entry.name.slice(0, -".png".length));
		}
	}

	return names.toSorted((a, b) => a.localeCompare(b));
}

/** Empties `tiles/`, creating it if needed, so no tile outlives its PNG. */
async function resetTilesDir() {
	try {
		await Deno.remove(TILES_DIR, { recursive: true });
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) {
			throw error;
		}
	}

	await Deno.mkdir(TILES_DIR, { recursive: true });
}

await resetTilesDir();

const names = await listImages();
const built = await Promise.all(names.map((name) => buildTile(name)));

// `pnpm start` and `pnpm preview` run this script first, so the per-icon lines are opt-in rather
// than printed ahead of every local run.
if (Deno.args.includes("--verbose")) {
	for (const {
		name,
		canvasWidth,
		canvasHeight,
		tile: { width, height, bottomPadding },
		left,
		right,
		top,
	} of built) {
		log.info(
			`${hl.entity(name.padEnd(16))} ${String(canvasWidth)}x${String(canvasHeight)} → trimmed ${hl.value(`${String(width)}x${String(height - bottomPadding)}px`)} (left ${String(left)}, right ${String(right)}), bottom padding ${hl.value(`${String(bottomPadding)}px`)} (top ${String(top)})`
		);
	}
}

const widths = built.map(({ tile }) => tile.width);
const heights = built.map(({ tile }) => tile.height);
const paddings = built.map(({ tile }) => tile.bottomPadding);
const totalBytes = built.reduce((sum, { bytes }) => sum + bytes, 0);

log.success(
	`${String(built.length)} tiles, ${hl.value(`${String(totalBytes)}B`)}: width ${hl.value(`${String(Math.min(...widths))}–${String(Math.max(...widths))}px`)} (cell ${String(CELL_WIDTH)}), height ${hl.value(`${String(Math.min(...heights))}–${String(Math.max(...heights))}px`)} (cell ${String(CELL_HEIGHT)}), bottom padding ${hl.value(`${String(Math.min(...paddings))}–${String(Math.max(...paddings))}px`)} (overlap ${String(-ROW_GAP)})`
);

// The renderer rejects a tile larger than its cell, and a tile with less bottom padding than the
// overlap would have the row below drawn over its art, so the build fails instead of shipping one.
let failed = false;

for (const { name, tile } of built) {
	const reasons: string[] = [];

	if (tile.width > CELL_WIDTH) {
		reasons.push(`width ${String(tile.width)}px exceeds CELL_WIDTH ${String(CELL_WIDTH)}px`);
	}

	if (tile.height > CELL_HEIGHT) {
		reasons.push(`height ${String(tile.height)}px exceeds CELL_HEIGHT ${String(CELL_HEIGHT)}px`);
	}

	if (tile.bottomPadding < -ROW_GAP) {
		reasons.push(
			`bottom padding ${String(tile.bottomPadding)}px is less than the ${String(-ROW_GAP)}px row overlap`
		);
	}

	if (reasons.length > 0) {
		failed = true;
		log.error(`${hl.entity(`${name}.tile`)}: ${reasons.join("; ")}`);
	}
}

if (failed) {
	Deno.exitCode = 1;
}
