import type { Image } from "@matmen/imagescript";
import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";

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
const COLUMN_GAP = 16;
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
 * PNG deflate level, 0–9. Lossless, so it only trades encode CPU for file size — worth the max
 * since these are native-resolution tiles and egress is the tighter Deploy budget.
 */
const PNG_COMPRESSION = 9;

/**
 * Decoded, trimmed tiles keyed by icon URL. Only ~120 distinct card arts exist, and warm isolates
 * keep the map across cron ticks, so after warmup most renders skip the fetch+decode entirely.
 * Caching the _promise_ (not the image) also dedupes concurrent fetches — both decks of a battle,
 * and all targets on a cron tick, render in parallel. `composite` reads its source without mutating
 * it, so sharing cached tiles across renders is safe.
 */
const tileCache = new Map<string, Promise<Image>>();

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
 * on it (see `renderDeckGrid`) lines the card frames up, whereas trimming to each card's own lowest
 * opaque pixel would follow per-card shadow/decoration variation instead. Kept at native resolution
 * — the only resize ImageScript offers is nearest-neighbour, which softens detailed art.
 */
function trimToArt(image: Image): Image {
	const { bitmap, width, height } = image;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	// Index the raw RGBA bitmap directly (alpha is byte 3 of each quad) — this scans every pixel,
	// and per-pixel getPixelAt would pay a bounds-check call plus a big-endian u32 read each time.
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if ((bitmap[(y * width + x) * 4 + 3] ?? 0) > ALPHA_THRESHOLD) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	// Fully transparent (shouldn't happen for card art): leave it rather than crop to nothing.
	if (maxX < 0) {
		return image;
	}

	// The negative ROW_GAP overlaps the row below into this tile's kept bottom padding; if the art
	// leaves less padding than the overlap (e.g. a future frame style), it would clip — say so.
	const bottomPadding = height - 1 - maxY;
	if (bottomPadding < -ROW_GAP) {
		console.warn(
			`card art bottom padding ${String(bottomPadding)}px < row overlap ${String(-ROW_GAP)}px; grid rows may clip`
		);
	}

	return image.crop(minX, minY, maxX - minX + 1, height - minY);
}

async function fetchTile(url: string): Promise<Image> {
	const [{ Image }, response] = await Promise.all([loadImageScript(), fetch(url)]);

	if (!response.ok) {
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	return trimToArt(await Image.decode(new Uint8Array(await response.arrayBuffer())));
}

function loadTile(url: string): Promise<Image> {
	const cached = tileCache.get(url);

	if (cached !== undefined) {
		return cached;
	}

	const pending = fetchTile(url);

	tileCache.set(url, pending);
	// Evict on failure so one bad fetch doesn't poison the cache forever; callers still see the
	// rejection through their own await.
	pending.catch(() => tileCache.delete(url));

	return pending;
}

/**
 * Composites a deck into a 4-column PNG grid (2 rows for a full 8-card deck; short decks simply
 * leave trailing cells empty). Throws on an empty deck or an icon fetch/decode failure — the caller
 * falls back to the text-only message. Logs elapsed ms and cache misses so the real per-game CPU
 * cost is observable in Deploy logs.
 */
async function renderDeckGrid(cards: Card[]): Promise<Uint8Array<ArrayBuffer>> {
	const [first] = cards;

	if (first === undefined) {
		throw new Error("No cards to render");
	}

	const start = performance.now();
	const cachedBefore = tileCache.size;
	const [{ Image }, tiles] = await Promise.all([
		loadImageScript(),
		Promise.all(cards.map((card) => loadTile(iconUrl(card)))),
	]);
	const fetched = tileCache.size - cachedBefore;

	const composeStart = performance.now();
	// One cell size for every card, so all rows are equal height and the grid stays consistent
	// across decks. Trimmed tiles vary slightly, so take the max for both dimensions.
	const tileWidth = Math.max(...tiles.map((tile) => tile.width));
	const tileHeight = Math.max(...tiles.map((tile) => tile.height));
	const rows = Math.ceil(tiles.length / COLUMNS);
	const width = COLUMNS * tileWidth + (COLUMNS - 1) * COLUMN_GAP;
	const height = rows * tileHeight + (rows - 1) * ROW_GAP;
	const canvas = new Image(width, height);

	for (const [index, tile] of tiles.entries()) {
		// Centre horizontally, align to the cell's bottom. Tiles keep their native bottom edge
		// (`trimToArt`), so bottom-aligning rests every card on the same baseline; taller frames
		// (hexagonal legendaries/champions) and gems/emblems (evolutions/heroes) extend upward, the
		// way the art is drawn. Centring would leave shorter cards floating and off-centre.
		const cellX = (index % COLUMNS) * (tileWidth + COLUMN_GAP);
		const cellY = Math.floor(index / COLUMNS) * (tileHeight + ROW_GAP);
		const x = cellX + Math.floor((tileWidth - tile.width) / 2);
		const y = cellY + (tileHeight - tile.height);
		canvas.composite(tile, x, y);
	}

	// Re-wrap onto a fresh ArrayBuffer: ImageScript types encode() as Uint8Array<ArrayBufferLike>,
	// which BlobPart (File/FormData) rejects. One small copy per render.
	const png = new Uint8Array(await canvas.encode(PNG_COMPRESSION));
	const end = performance.now();

	// Size is worth logging: tiles composite at whatever resolution the CDN serves (no resize), so a
	// CDN art upgrade would silently grow every upload toward Discord's attachment limit.
	const elapsed = formatDuration(Math.round(end - start), { ignoreZero: true });
	const composeElapsed = formatDuration(Math.round(end - composeStart), { ignoreZero: true });
	console.log(
		`deck grid: ${String(tiles.length)} tiles (${String(fetched)} fetched), ${formatBytes(png.length)}, in ${elapsed} (compose+encode ${composeElapsed})`
	);

	return png;
}

export { renderDeckGrid };
