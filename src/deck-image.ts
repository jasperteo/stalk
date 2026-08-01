import { Buffer } from "node:buffer";

import { format as formatBytes } from "@std/fmt/bytes";
import { format as formatDuration } from "@std/fmt/duration";
import type { SharpConstructor } from "sharp";

import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * Imported lazily so its codec native binding loads on the first render rather than at every
 * isolate cold boot, and memoized so subsequent renders reuse the resolved module.
 * `sharp.cache(false)` disables libvips' own operation cache — the deck LRU is the only cache we
 * want; libvips' would just hold memory.
 *
 * `sharp.concurrency(1)` collapses libvips' per-pipeline thread pool to a single thread, trading
 * wall time for total CPU. Parallelism doesn't remove work, it spreads it, and this is a cron job:
 * nothing is waiting on the render, so wall time is nearly worthless here while CPU time is what
 * Deploy bills. `loadTile` also runs every tile through `Promise.all` already, so 8–24 pipelines
 * are in flight at once and each spawning its own pool is pure oversubscription — the app-level
 * parallelism survives this, only the redundant intra-pipeline threading goes.
 *
 * Measured locally (default pool = 5, 20 renders, user+sys across all threads): an 8-card deck goes
 * 1.14 → 0.84 CPU-seconds and a 24-card duel 3.69 → 2.81, both ~25% less, while per-render wall
 * time roughly doubles (10 → 17 ms, 28 → 52 ms). Kernel time nearly halves, which is the thread
 * coordination this removes. `concurrency(2)` is the hedge if that wall cost ever matters: most of
 * the CPU win for half the latency. Revisit all of this if Deploy ever bills isolate wall time
 * rather than CPU — the trade inverts.
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
			sharp.concurrency(1);
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
 * PNG zlib compressionLevel (0–9) for the shipped grid. 0 is zlib _stored_ — no compression at all,
 * so the encode is effectively a memcpy and the output is exactly `width × height × 4` plus ~0.2%
 * PNG framing. Still lossless, and still a PNG: levels 0 and 6 decode to byte-identical pixels, so
 * nothing about image quality changes.
 *
 * Deliberately trading upload size for encode CPU, which is the scarcer resource on Deno Deploy.
 * Encode-stage medians of 11 on a 4-column grid: an 8-card deck is 2 ms / 0.65 MiB here against 8
 * ms / 0.35 MiB at level 6, and a 24-card duel 4 ms / 2.02 MiB against 21 ms / 1.05 MiB. Levels 1–6
 * measured indistinguishable from each other on both axes, so 0 is the only step down that buys
 * anything — don't reach for 3 expecting a middle ground.
 *
 * Raising this again means lowering DECK_CACHE_BYTES to match; the two were changed together.
 */
const GRID_COMPRESSION = 0;
/**
 * Max width of the shipped grid, in px. Compose still happens at native resolution (1080 px for 4
 * columns) and only the finished grid is scaled down, so this is a single high-quality Lanczos pass
 * rather than per-tile blur — the "tiles composite at native resolution" rule is untouched. Discord
 * renders embed images a few hundred px wide, so 480 still covers that.
 *
 * At GRID_COMPRESSION 0 this is a bytes decision, not a CPU one. A stored PNG encodes at the same
 * few milliseconds whatever its size (the whole table below is 2–5 ms), so the downscale neither
 * pays for itself nor costs anything measurable — what it buys is a 5× smaller upload. It also
 * keeps a duel inside Discord's ~10 MiB per-message limit: a 24-card grid at native is 10.23 MiB on
 * its own, and a post carries two.
 *
 * Measured on a 4-column grid (median of 11, compressionLevel 0). Sizes are exact and
 * deck-independent at level 0 — a stored PNG is just `width × height × 4` plus framing — so unlike
 * the level-6 figures this replaced, they don't drift with the art:
 *
 * | cards | native (1080 px) | 720 px         | 480 px         |
 * | ----- | ---------------- | -------------- | -------------- |
 * | 8     | 3.28 MiB, 2 ms   | 1.46 MiB, 2 ms | 0.65 MiB, 2 ms |
 * | 16    | 6.75 MiB, 3 ms   | 3.00 MiB, 4 ms | 1.33 MiB, 3 ms |
 * | 24    | 10.23 MiB, 5 ms  | 4.55 MiB, 5 ms | 2.02 MiB, 4 ms |
 *
 * Shipped dimensions at 480: 480×353 (8 cards), 480×727 (16), 480×1101 (24).
 */
const MAX_GRID_WIDTH = 480;
/**
 * Abort a fallback card-icon CDN fetch after this long, so a hung request can't stall the cron
 * tick.
 */
const ICON_TIMEOUT_MS = 10_000;
/**
 * Secondary entry-count guard on the deck cache, alongside the byte budget. Defaults to a value
 * that is sane with no configuration at all (offline scripts, tests); `main.ts` raises it from the
 * live target count at startup, so the renderer never reads app config itself.
 */
let deckCacheLimit = 10;

/**
 * Raises the entry-count guard, called once from the composition root. Sized from the target count
 * so growing TARGETS keeps each tracked player's decks warm plus headroom for opponent decks.
 */
function configureDeckCache(targetCount: number) {
	deckCacheLimit = 3 * targetCount + 10;
}

/**
 * Memory ceiling for finished grids, in bytes. Entry size varies several-fold between a ladder deck
 * and a 24-card duel, and the old entry-count cap also grew with TARGETS — so a byte budget is the
 * only bound that actually caps isolate memory. A typical 8-card grid is 0.65 MiB, so 22 MiB holds
 * roughly 33 ladder decks, or about 10 full 24-card duels in the worst case.
 *
 * Raised from 12 MiB alongside GRID_COMPRESSION 0, which made every grid ~1.8× bigger. Holding the
 * budget flat would have cut the cache to ~18 decks and spent the encode CPU straight back on
 * re-renders, so the two constants move together — don't lower this without raising that.
 */
const DECK_CACHE_BYTES = 22 * 1024 * 1024;
/** Cards in a Clash Royale deck. A duel stacks 2 or 3 decks, so `cards.length` is 16 or 24. */
const DECK_SIZE = 8;
/** Rows one 8-card deck block occupies in the 4-column grid. */
const ROWS_PER_DECK = Math.ceil(DECK_SIZE / COLUMNS);
/**
 * Vertical space inserted between deck blocks, replacing the negative ROW_GAP that tightens rows
 * _within_ one deck — so a duel's 2–3 stacked decks read as separate 8-card decks. A normal single
 * deck has no block boundary, so this never affects it. Wide enough to seat the divider with
 * clearance; tune alongside DIVIDER_* via `deno task preview` on a 16-card deck.
 */
const DECK_GAP = 48;
/**
 * Divider-rule thickness, in native px. Kept thick enough to survive Discord's downscale of the
 * grid.
 */
const DIVIDER_THICKNESS = 4;
/**
 * Deck-boundary divider colour, straight-alpha RGBA. A muted, semi-transparent grey reads as a soft
 * separator on Discord's embed background in both light and dark client themes.
 */
const DIVIDER_COLOR = { r: 154, g: 160, b: 166, alpha: 140 } as const;

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
 * One cache slot: the in-flight or finished render, plus the byte size eviction charges for it.
 * Bundling the two means every path that removes a slot removes its accounting with it — a separate
 * size map would have to be kept in step by hand at each mutation site. `bytes` stays 0 until the
 * render resolves, since a pending render has no size yet.
 */
type DeckCacheEntry = { png: Promise<Uint8Array<ArrayBuffer>>; bytes: number };

/**
 * Finished grids keyed by the deck's ordered mirror filenames, so a repeated deck skips the render.
 * The only cache here — per-tile reads are covered by the OS page cache. A small LRU: hits
 * re-insert at the back, inserts evict from the front. The cached bytes are shared across posts —
 * safe because callers only wrap them in a `File`, never mutate them.
 */
const deckCache = new Map<string, DeckCacheEntry>();
/** Running total of `deckCache`'s resolved bytes; an entry contributes 0 until its render lands. */
let deckCacheBytes = 0;

/**
 * Evicts from the front of `deckCache` (oldest / least-recently-used) until both the byte budget
 * and the entry-count guard are satisfied. Size travels inside the entry, so removing one can't
 * leave its bytes behind in the running total.
 */
function evictDeckCache(): void {
	while (deckCacheBytes > DECK_CACHE_BYTES || deckCache.size > deckCacheLimit) {
		const oldest = deckCache.entries().next().value;

		if (oldest === undefined) {
			break;
		}

		const [key, entry] = oldest;

		deckCache.delete(key);
		deckCacheBytes -= entry.bytes;
	}
}

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
 *
 * Zero-fills (`Buffer.alloc`, not `allocUnsafe`): `subarray` clamps silently on a short row, so an
 * out-of-bounds region would otherwise leave uninitialized heap bytes in the tail of a row instead
 * of failing loudly. The guard below is expected to make that path unreachable, but the zero-fill
 * is cheap insurance against a future caller that doesn't have `scanArtBounds`'s invariants.
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

/**
 * A solid horizontal rule as a raw straight-alpha RGBA bitmap of `width`×DIVIDER_THICKNESS, ready
 * to composite. Filled in JS rather than via a `sharp({create})` round-trip, matching how tiles
 * stay in raw memory. Returns a `Buffer` so it feeds `OverlayOptions.input` without a cast, like
 * `cropRaw`.
 */
function solidRule(
	width: number,
	color: { r: number; g: number; b: number; alpha: number }
): Buffer {
	const rule = Buffer.allocUnsafe(width * DIVIDER_THICKNESS * BYTES_PER_PIXEL);

	for (let offset = 0; offset < rule.length; offset += BYTES_PER_PIXEL) {
		rule[offset] = color.r;
		rule[offset + 1] = color.g;
		rule[offset + 2] = color.b;
		rule[offset + 3] = color.alpha;
	}

	return rule;
}

/**
 * Trims a decoded bitmap's transparent margin on the top and sides but keeps its native bottom
 * edge: every icon shares that baseline, so bottom-aligning on it (see `composeDeckGrid`) lines the
 * card frames up. Kept at native resolution, since upscaling would blur.
 *
 * Scans the art bounds, then slices the region straight out of the bitmap — the trimmed
 * `bottomPadding` is the transparent band the compose layer lets the row below overlap into.
 *
 * Takes an already-decoded `RawImage` rather than encoded bytes so a caller that already holds one
 * (`fetchTile`, straight off its resize) doesn't have to encode just to have this decode again.
 */
function trimRaw(raw: RawImage): Tile {
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

/** Decodes an encoded icon, then trims it — see `trimRaw`. The local-art path's entry point. */
async function trimToArt(bytes: Uint8Array): Promise<Tile> {
	return trimRaw(await decodeToRaw(bytes));
}

/**
 * Fetches a fallback card icon and resizes it to fit inside the cell before decoding. `CELL_WIDTH`/
 * `CELL_HEIGHT` are the upper bound of every _local_ icon's trimmed size (`deno task measure`); the
 * CDN path has no such guarantee (a brand-new card's art may simply be bigger), and the overlay
 * math in `composeDeckGrid` assumes every tile fits its cell — an oversized tile pushes
 * `left`/`top` negative there, which sharp clips silently instead of erroring. `fit: "inside"`
 * preserves aspect ratio; `withoutEnlargement` leaves already-small art untouched, so a normal
 * fallback (which does fit) is unaffected.
 */
async function fetchTile(url: string): Promise<Tile> {
	const response = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });

	if (!response.ok) {
		// Drain so the connection is released rather than pinned by an unread body.
		await response.body?.cancel();
		throw new Error(`Card icon ${String(response.status)} for ${url}`);
	}

	const fetched = new Uint8Array(await response.arrayBuffer());
	const sharp = await loadSharp();

	// One instance for both the header read and the pipeline below — a second `sharp(fetched)` would
	// parse the same buffer again.
	const image = sharp(fetched);
	const { width, height } = await image.metadata();

	if (width > CELL_WIDTH || height > CELL_HEIGHT) {
		log.warn(
			`CDN icon ${hl.strong(`${String(width)}x${String(height)}`)} exceeds the ${hl.strong(`${String(CELL_WIDTH)}x${String(CELL_HEIGHT)}`)} cell for ${url}; shrinking to fit`
		);
	}

	// Out as raw RGBA, not PNG: `trimRaw` wants a decoded bitmap, so encoding here would only buy a
	// deflate pass plus the inflate to undo it. Same rule `cropRaw` follows — stay in raw memory.
	const { data, info } = await image
		.resize({ width: CELL_WIDTH, height: CELL_HEIGHT, fit: "inside", withoutEnlargement: true })
		.ensureAlpha()
		.raw()
		.toUint8Array();

	return trimRaw({ data, width: info.width, height: info.height });
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

	// Top y of each row. Rows inside one deck overlap by ROW_GAP (negative, tightening them); the
	// first row of each new deck block is pushed down by the positive DECK_GAP instead, so a duel
	// (16 or 24 cards = 2 or 3 blocks of 8) renders as separate decks. A single 8-card deck has one
	// block, so every gap is ROW_GAP and the layout is identical to before.
	const rowTops: number[] = [];
	let nextTop = 0;
	for (let row = 0; row < rows; row++) {
		if (row > 0) {
			const startsBlock = row % ROWS_PER_DECK === 0;
			nextTop += CELL_HEIGHT + (startsBlock ? DECK_GAP : ROW_GAP);
		}

		rowTops.push(nextTop);
	}
	const height = nextTop + CELL_HEIGHT;

	const tileOverlays = tiles.map((tile, index) => {
		const row = Math.floor(index / COLUMNS);

		// Warn only when the row directly below is in the SAME deck block (a ROW_GAP overlap) and this
		// tile's kept bottom padding can't cover it, so the row below would clip its art. A block
		// boundary below uses the positive DECK_GAP, which never clips; bottom-row tiles have no row
		// below.
		const rowBelowStartsBlock = (row + 1) % ROWS_PER_DECK === 0;
		if (row < rows - 1 && !rowBelowStartsBlock && tile.bottomPadding < -ROW_GAP) {
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

	// One full-width divider rule centred in each deck-boundary gap band (none for a single 8-card
	// deck, so ordinary decks composite exactly as before).
	const dividerOverlays: typeof tileOverlays = [];
	for (let row = ROWS_PER_DECK; row < rows; row += ROWS_PER_DECK) {
		const bandTop = (rowTops[row - 1] ?? 0) + CELL_HEIGHT;
		const top = bandTop + Math.floor((DECK_GAP - DIVIDER_THICKNESS) / 2);

		dividerOverlays.push({
			input: solidRule(width, DIVIDER_COLOR),
			raw: { width, height: DIVIDER_THICKNESS, channels: 4 as const },
			left: 0,
			top,
		});
	}

	const overlays = [...tileOverlays, ...dividerOverlays];

	const composed = await sharp({
		create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.composite(overlays)
		.raw()
		.toUint8Array();

	// Second pipeline, deliberately: sharp applies resize BEFORE composite within a single pipeline, so
	// scaling the finished grid has to happen over the already-composed bitmap. Raw in, PNG out — one
	// encode, no intermediate PNG round-trip. `withoutEnlargement` is defensive only; the composed
	// width is always 1080 (see the `width` derivation above), so this always shrinks.
	const { data } = await sharp(composed.data, { raw: { width, height, channels: 4 } })
		.resize({ width: MAX_GRID_WIDTH, withoutEnlargement: true })
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
		return cached.png;
	}

	// Cached before the first await, so concurrent renders of the same deck dedupe on this promise.
	const entry: DeckCacheEntry = { png: composeDeckGrid(cards), bytes: 0 };
	deckCache.set(key, entry);

	try {
		const png = await entry.png;

		// Account on resolution — a pending render has no size yet. Only if this entry is still the
		// cached one; an eviction during the render means it is no longer ours to account for.
		if (deckCache.get(key) === entry) {
			entry.bytes = png.length;
			deckCacheBytes += png.length;
			evictDeckCache();
		}

		return png;
	} catch (error) {
		// Identity-checked: an eviction during the render may have replaced this entry, and deleting
		// blindly would drop a healthy newer one.
		if (deckCache.get(key) === entry) {
			deckCache.delete(key);
		}

		throw error;
	}
}

export {
	CELL_HEIGHT,
	CELL_WIDTH,
	configureDeckCache,
	DECK_CACHE_BYTES,
	decodeToRaw,
	IMAGES_DIR,
	MAX_GRID_WIDTH,
	renderDeckGrid,
	scanArtBounds,
	trimToArt,
};
export type { RawImage };
