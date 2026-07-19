import { decodeToRaw, IMAGES_DIR, scanArtBounds, type RawImage } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";

/**
 * Dev-only measuring tool: reports the transparent margins baked into a card icon, the numbers
 * deck-image.ts's `trimToArt`/`composeDeckGrid` are tuned against. Reads the renderer's own
 * `IMAGES_DIR` (not the CDN), so it measures exactly the directory the renderer reads and stays
 * offline and hermetic enough to run on a whim.
 *
 * Usage: `deno task measure 26000032 26000032-evo` — bare card ids resolve to `images/<id>.png`; a
 * `-evo`/`-hero` suffix picks that variant. With no args it measures every icon in `images/` and
 * prints the aggregate row, which is what ROW_GAP's floor and the grid's cell width come from.
 */

type Measurement = {
	name: string;
	width: number;
	height: number;
	/** Width of the art itself: what a side-trimmed tile occupies in the grid. */
	trimmedWidth: number;
	/** Height of the art itself, from its topmost to its lowest opaque pixel. */
	trimmedHeight: number;
	left: number;
	right: number;
	/** Transparent band above the art — `trimToArt` cuts this. */
	top: number;
	/**
	 * Transparent band below the art, from the card's lowest opaque pixel to the image's bottom edge.
	 * `trimToArt` keeps it as the shared baseline, and the negative ROW_GAP overlaps into it.
	 */
	bottom: number;
};

function measure(name: string, image: RawImage): Measurement {
	const { width, height } = image;
	// The exact bounds scan the renderer trims with (`trimToArt` in deck-image.ts wraps this same
	// function), so these margins are precisely what it sees — no risk of the two drifting.
	const { minX, minY, maxX, maxY } = scanArtBounds(image);

	if (maxX < 0) {
		throw new Error(`${name} is fully transparent`);
	}

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

async function measureFile(name: string): Promise<Measurement> {
	const file = new URL(`${name}.png`, IMAGES_DIR);
	return measure(name, await decodeToRaw(await Deno.readFile(file)));
}

async function listImages(): Promise<string[]> {
	const names: string[] = [];

	for await (const entry of Deno.readDir(IMAGES_DIR)) {
		if (entry.isFile && entry.name.endsWith(".png")) {
			names.push(entry.name.slice(0, -".png".length));
		}
	}

	return names.toSorted();
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

	// The floor here is what bounds ROW_GAP: overlap deeper than the thinnest bottom band clips art.
	log.success(
		`${String(measurements.length)} icons: trimmed width ${hl.value(`${String(Math.min(...widths))}–${String(Math.max(...widths))}px`)}, trimmed height ${hl.value(`${String(Math.min(...heights))}–${String(Math.max(...heights))}px`)}, bottom padding ${hl.value(`${String(Math.min(...bottoms))}–${String(Math.max(...bottoms))}px`)}`
	);
}
