/**
 * @module
 *
 * Prints the transparent margins around the art in card icons: the numbers that `CELL_WIDTH`,
 * `CELL_HEIGHT` and `ROW_GAP` in `src/deck-image.ts` are based on. It reads the renderer's own
 * `IMAGES_DIR` and uses the renderer's own decoding and bounds scan, so its numbers match what a
 * render sees. It never touches the network.
 *
 * `pnpm measure` measures every PNG in `images/` and ends with a line of ranges. `pnpm measure
 * 26000032 26000032-evo` measures only the named files: a card id reads `images/<id>.png`, and an id
 * with a `-evo` or `-hero` suffix reads that variant. Run it again after adding art to `images/`.
 */

import type { RawImage } from "@/deck-image.ts";
import { decodeToRaw, IMAGES_DIR, scanArtBounds } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";

/** One icon's canvas size, the size of the art inside it, and the transparent margins around it. */
type Measurement = {
	name: string;
	width: number;
	height: number;
	/**
	 * The width of the art. Tiles are trimmed on both sides, so this is also the tile's width in the
	 * grid, and `CELL_WIDTH` must be at least the largest.
	 */
	trimmedWidth: number;
	/**
	 * The height of the art alone, from its top row to its lowest opaque row. A tile is taller than
	 * this, because it keeps the bottom padding.
	 */
	trimmedHeight: number;
	/** Transparent columns left of the art. Trimming removes them. */
	left: number;
	/** Transparent columns right of the art. Trimming removes them. */
	right: number;
	/**
	 * Transparent rows above the art. Trimming removes them, so the tallest tile is the canvas height
	 * minus the smallest `top`, and that sets `CELL_HEIGHT`.
	 */
	top: number;
	/**
	 * Transparent rows below the art, down to the bottom edge of the canvas. The tile keeps them, and
	 * the row overlap set by `ROW_GAP` has to stay smaller than the smallest.
	 */
	bottom: number;
};

/**
 * Measures one decoded icon.
 *
 * @throws When the icon is fully transparent, which would mean a broken file in `images/`.
 */
function measure(name: string, image: RawImage): Measurement {
	const { width, height } = image;
	// The same scan `trimToArt` uses in the renderer, so these bounds are the ones a render trims to.
	const bounds = scanArtBounds(image);

	if (bounds === undefined) {
		throw new Error(`${name} is fully transparent`);
	}

	const { minX, minY, maxX, maxY } = bounds;

	return {
		name,
		width,
		height,
		trimmedWidth: maxX - minX + 1,
		trimmedHeight: maxY - minY + 1,
		left: minX,
		right: width - 1 - maxX,
		top: minY,
		bottom: height - 1 - maxY,
	};
}

/** Reads and measures `images/<name>.png`. */
async function measureFile(name: string) {
	const file = new URL(`${name}.png`, IMAGES_DIR);
	return measure(name, await decodeToRaw(await Deno.readFile(file)));
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

const names = Deno.args.length > 0 ? Deno.args : await listImages();
const measurements = await Promise.all(names.map((name) => measureFile(name)));

for (const {
	name,
	width,
	height,
	trimmedWidth,
	trimmedHeight,
	left,
	right,
	top,
	bottom,
} of measurements) {
	log.info(
		`${hl.entity(name.padEnd(16))} ${String(width)}x${String(height)} → trimmed ${hl.value(`${String(trimmedWidth)}x${String(trimmedHeight)}px`)} (left ${String(left)}, right ${String(right)}), bottom padding ${hl.value(`${String(bottom)}px`)} (top ${String(top)})`
	);
}

if (measurements.length > 1) {
	const widths = measurements.map(({ trimmedWidth }) => trimmedWidth);
	const heights = measurements.map(({ trimmedHeight }) => trimmedHeight);
	const bottoms = measurements.map(({ bottom }) => bottom);

	// The width range bounds `CELL_WIDTH`, and the smallest bottom padding bounds the row overlap.
	// The smallest `top`, which sets `CELL_HEIGHT`, is only in the per-icon lines above.
	log.success(
		`${String(measurements.length)} icons: trimmed width ${hl.value(`${String(Math.min(...widths))}–${String(Math.max(...widths))}px`)}, trimmed height ${hl.value(`${String(Math.min(...heights))}–${String(Math.max(...heights))}px`)}, bottom padding ${hl.value(`${String(Math.min(...bottoms))}–${String(Math.max(...bottoms))}px`)}`
	);
}
