# Deck rendering tuning log

`src/deck-image.ts` composites a Clash Royale deck into a single PNG grid via
[sharp](https://sharp.pixelplumbing.com/): each card's local art is trimmed to its opaque bounds,
placed into a fixed-size cell, and the finished grid is composed and encoded once, at native
resolution. There is no downscale step. This doc is the authority on why each constant in that
module has the value it does and what breaks if you change it. The source carries a short JSDoc per
constant, with an `@see` anchor back to the relevant section where one exists. Organized by topic,
not declaration order.

## Single pipeline

`renderDeckGrid` composes and encodes in one sharp pipeline: a `create` canvas, all tile overlays,
and `.png(...)`, in a single `sharp({ create }).composite(overlays).png(...)` call, with no resize
stage and no intermediate raw-bitmap round trip. That's only possible because the grid now ships at
native resolution (1080 px wide for 4 columns): there's nothing left to scale after compositing.

This module used to need a second pipeline for exactly that reason. sharp applies `resize` before
`composite` within a single pipeline regardless of the order the methods are chained in code, so
scaling the _finished_, already-composed grid down could never happen in the same pipeline that
composed it. Doing so would run the resize first, against an empty canvas, and every tile overlay
would land at the wrong scale. The extra pass existed solely to serve the downscale described in
[Output size](#output-size); once the grid stopped downscaling, compose and encode fused into the
single pipeline above.

## sharp runtime config

`sharpModule`, a `Lazy` from `@std/async` holding sharp's constructor, imports `sharp` on first
render rather than at every cold boot, and memoizes the resolved module. Two calls follow
immediately on load:

- **`sharp.cache(false)`** disables libvips' own operation cache. This module keeps no cache of its
  own either (see [No cache](#no-cache)). Deno Deploy cold-starts the app on essentially every cron
  tick, so libvips' cache can never accumulate a hit across renders that matter; it would only hold
  memory it never reuses.
- **`sharp.concurrency(1)`** collapses libvips' per-pipeline thread pool to a single thread, trading
  wall time for total CPU. This is a cron job. Nothing is waiting synchronously on one render, so
  wall time is nearly worthless while CPU time is what Deno Deploy bills. `renderDeckGrid` already
  runs every tile's `loadTile` through `Promise.all`, so all 8 pipelines of a deck are in flight
  concurrently regardless; letting each of those _also_ spawn its own thread pool is pure
  oversubscription. Collapsing to 1 thread removes only the redundant intra-pipeline threading. The
  app-level (inter-pipeline) parallelism is untouched.

Measured on the 8-card deck in [`scripts/preview.ts`](../scripts/preview.ts), one child process per
setting, 20 renders each, 3 runs per setting (spread under ±0.02 CPU-seconds and ±0.2 ms). CPU is
`user + sys` for the whole process, summed across threads; the per-render column has the startup
baseline noted below the table subtracted out:

| Pool setting     | CPU-seconds (20 renders) | CPU per render | Wall per render |
| ---------------- | ------------------------ | -------------- | --------------- |
| default (pool 5) | 0.95                     | ~45 ms         | 8.2 ms          |
| `concurrency(2)` | 0.80                     | ~37 ms         | 8.8 ms          |
| `concurrency(1)` | **0.70** (~26% less)     | **~33 ms**     | **11.4 ms**     |

An otherwise identical process that loads sharp and decodes the tiles but renders nothing costs
0.05 CPU-seconds, which is what the per-render column has removed. Kernel time halves under
`concurrency(1)`: `sys` goes 0.30 → 0.15 s. That is exactly the thread-coordination overhead this
removes.

`sharp.concurrency(2)` is the documented hedge if wall time ever starts to matter, and it is a
better hedge than it used to read here. It takes **60% of the CPU win for under 20% of the added
latency** (0.15 s of the 0.25 s saved, at 0.6 ms of the 3.2 ms cost). **Revisit this whole trade if
Deno Deploy ever bills instance wall time rather than CPU. The trade inverts.**

Only a _successful_ load is memoized, which is why `Lazy` is used rather than a bare promise memo:
it clears its state when the initializer rejects, so the next render retries. Caching the rejection
instead is the bare `sharpModule ??= import(...)` shape. It would let one transient dlopen failure
poison every later render for the instance's lifetime, and silently: `discord.ts` catches a failed
render and posts the text-only fallback, so the symptom would be decks quietly vanishing from every
post rather than a visible crash.

### Output method: `toBuffer` vs `toUint8Array`

Every value that leaves sharp does so through **`toBuffer()`**. The alternative reads like a
different return shape and isn't. `toUint8Array()` is `toBuffer` with two options preset
(`sharp/dist/output.mjs`):

```js
function toUint8Array() {
	this.options.resolveWithObject = true; // why call sites destructure { data, info }
	this.options.typedArrayOut = true;
	const stack = Error();
	return this._pipeline(null, stack);
}
```

`typedArrayOut` picks a branch in sharp's native `pipeline.cc`:

| method           | native call                     | libvips memory                             |
| ---------------- | ------------------------------- | ------------------------------------------ |
| `toUint8Array()` | `Napi::Buffer<char>::Copy`      | **full memcpy**, then freed immediately    |
| `toBuffer()`     | `Napi::Buffer<char>::NewOrCopy` | wrapped externally, zero-copy, freed on GC |

So `toUint8Array()` allocates a second full-size backing store before releasing libvips'. A render
decodes 8 tiles at ~478 KB each and encodes a 3,436,474-byte PNG, and those transient duplicates
accumulate faster than GC reclaims them. Measured on the same 8-card deck, 40 renders per process,
sampling `Deno.memoryUsage().rss` per render, 3 runs per configuration (peak RSS spread under
2 MiB):

| Output sites on `toBuffer`  | Mean render | Peak RSS      |
| --------------------------- | ----------- | ------------- |
| none (all `toUint8Array`)   | 11.9 ms     | 437.4 MiB     |
| `decodeToRaw` + `fetchTile` | 11.6 ms     | 289.2 MiB     |
| `renderDeckGrid` only       | 11.9 ms     | 329.5 MiB     |
| **all (current)**           | 12.5 ms     | **182.4 MiB** |

**2.4× less peak RSS, no change in render time.** The render-time column spans 0.9 ms across
configurations that differ by 255 MiB of RSS, which is noise, not signal. V8's heap stays ~9.8 MiB
in every configuration, so the whole difference is off-heap. Pixels are untouched: the grid
`pnpm preview` writes still hashes to
`613718b7499c7bb03629789e8b80346390c7e7f78fd5906977a35f4e4579c548`, unchanged since the switch.

Two things follow on the type side. `toBuffer()` is declared `Promise<Buffer<ArrayBuffer>>` with the
type argument pinned, so the encoded PNG reaches `File`/`FormData` uncast. `toUint8Array()` declares
a bare `Uint8Array` defaulting to `ArrayBufferLike`, the widening that `BlobPart` rejects. And
`RawImage.data` is declared `Buffer`, which it holds at runtime either way:
`Napi::Buffer::Copy` produces a JS `Buffer` too, so `toUint8Array()` never returned a plain
`Uint8Array` in the first place.

**Inputs are not part of this rule.** `decodeToRaw`/`trimToArt` keep `Uint8Array` parameters:
`Buffer` is a `Uint8Array` subclass, so those accept both, and `Deno.readFile`'s result flows in
with no wrapper. Wrapping it yourself would only duplicate what sharp's `_createInputDescriptor`
already does for typed arrays. That is a zero-copy `Buffer.from(buf, byteOffset, byteLength)`,
measured at 0.048 µs.

Measured on macOS arm64, 11 cores (Deno 2.9.5, V8 15.0.245.2, sharp 0.35.3), 2026-08-21, as is
every table in this document. Deno Deploy runs linux x64 on the same V8/napi/sharp, so the direction
holds; the magnitude there is unverified.

## Cell sizing

Tiles are never individually resized. Each card composites at native resolution into a fixed
`CELL_WIDTH` × `CELL_HEIGHT` cell, so the grid's pixel dimensions stay constant regardless of which
cards are in the deck. That means no per-deck layout recalculation, and no upscale blur on any one
tile.

`CELL_WIDTH = 261`, `CELL_HEIGHT = 405` are the upper bound of every local icon's _tile_ size, the
dimensions `trimRaw` actually produces. That is not quite what `pnpm measure` prints, so read
the two columns carefully:

- **Width** is the trimmed art, `maxX - minX + 1`, exactly the aggregate's `trimmed width`. Across
  all 180 icons that spans **257–261 px**, and `CELL_WIDTH` is the 261 (`26000061.png`).
- **Height** is `canvasHeight - minY`, the art _plus_ the transparent bottom margin `trimRaw`
  deliberately keeps as the shared baseline (see [Gaps and overlap](#gaps-and-overlap)). That is
  **not** the aggregate's `trimmed height` column, which reports `maxY - minY + 1` and tops out at
  387 px. The real bound is **346–405 px**, and `CELL_HEIGHT` is the 405 (`26000017-hero.png`).

The full aggregate, for reference:

```
180 icons: trimmed width 257–261px, trimmed height 314–387px, bottom padding 17–32px
```

Raising either constant shrinks nothing (cells just get emptier padding); lowering either without
re-measuring risks clipping the largest icon currently in `images/`. Sizing `CELL_HEIGHT` off the
`trimmed height` column instead would set it to 387 and clip 18 px off the bottom of the tallest
tile.

## Gaps and overlap

`COLUMN_GAP = 12` is the gutter between columns, in native pixels. Tiles are already trimmed on the
sides, so this is the true visual gap between adjacent cards.

`ROW_GAP = -16` is the gutter between rows, and it's negative on purpose. The upper row's
transparent bottom padding (the margin `trimRaw` kept below each card's art) overlaps the row below,
tightening the two rows together instead of leaving dead space under the shorter cards. There's a
floor around **-20**. Past that, hexagon and champion frames (which sit lower in their canvas than
most cards) start to clip into the row below.

`renderDeckGrid` also warns at render time when a specific tile's `bottomPadding` is smaller than
`-ROW_GAP`. That's exactly the clipping condition the -20 floor exists to avoid, caught per-tile
rather than only in aggregate.

## Encoding

`GRID_COMPRESSION = 0` sets the shipped PNG's zlib `compressionLevel` (range 0–9). Level 0 is zlib
_stored_, no compression at all, so the encode is effectively a memcpy and the output size is
exactly `width × height × 4` plus about 0.2% PNG framing overhead. It is still a valid, lossless
PNG: levels 0 and 6 decode to byte-identical pixels, so nothing about image quality changes, only
upload size and CPU.

With no resize stage (see [Single pipeline](#single-pipeline)), encode CPU can be measured directly
at native resolution. The grid is composed once, then encoded 11× at each level; median of 3 runs,
real composited grids of actual card art:

| Compression | CPU     | Size                   |
| ----------- | ------- | ---------------------- |
| level 0     | 1.7 ms  | 3.28 MiB (3,436,474 B) |
| level 6     | 28.8 ms | 1.42 MiB (1,489,813 B) |

Level 0's output is `1080 × 794 × 4 = 3,430,080` bytes of pixels plus 6,394 bytes of PNG framing.
That's 0.19%, the "about 0.2%" above.

Level 0 over level 6 buys ~27 ms per grid at a cost of ~1.86 MiB more per grid. That is a far more
lopsided case for level 0 than it used to be. Back when a resize sat between compose and encode,
that stage shrank the pixel count before deflate ever ran, narrowing the gap between the two
levels. With nothing shrinking the pixel count anymore, level 0 is an unambiguous win on the CPU
axis Deno Deploy actually bills.

## Output size

The deck grid ships at native resolution, 1080 px wide for 4 columns, with no downscale step. An
8-card deck's grid is 3.28 MiB at `GRID_COMPRESSION = 0` (see [Encoding](#encoding)). Eight is the
only deck size that reaches rendering, since `src/schema.ts` filters duels out during the battlelog
scan, before validation and before any rendering.

The grid used to be scaled down before shipping, in a second pass over the already-composed bitmap
(see [Single pipeline](#single-pipeline)). That stage was removed for CPU, not size. The two
superseded pipelines were reconstructed and re-measured alongside the current one. Each ran in its
own process, median of 21 renders, compose + encode, all three under `concurrency(1)`:

| Pipeline                                       | CPU     | Size     |
| ---------------------------------------------- | ------- | -------- |
| two-pipeline + resize to 480 px (old)          | 16.4 ms | 0.65 MiB |
| two-pipeline, no resize (superseded)           | 12.9 ms | 3.28 MiB |
| **fused single pipeline, no resize (current)** | 11.7 ms | 3.28 MiB |

The resize barely paid for its own encode-side savings. At `GRID_COMPRESSION = 0`, a stored PNG has
no deflate to shorten, so downscaling first bought the encode pass almost nothing. The Lanczos
resample cost real CPU (16.4 ms vs 12.9 ms) for a compression stage that wasn't doing anything
size-sensitive to begin with. Once the resize was gone, compose and encode fused into one pipeline,
which shaved a further 1.2 ms by skipping the raw-bitmap round trip out of sharp and back in
(12.9 ms vs 11.7 ms).

This is a deliberate CPU-for-bytes trade, not a free win. Shipping at native resolution costs
roughly 5× the upload bytes per grid (3.28 MiB vs 0.65 MiB), or 6.55 MiB per post, since a post
carries two grids, one per side. With no cache in this module (see [No cache](#no-cache)), there's
no cache-memory side of that cost anymore either. The trade is purely encode CPU against upload
bytes, which only strengthens the case for native resolution. It costs less CPU, and the extra bytes
buy nothing visible, since Discord renders embed images at a few hundred px wide regardless.

**The budget those 6.55 MiB are spent against is Discord's 10 MiB default request limit** ("The
default limit is `10 MiB` for all users, but may be higher … by the server's Boost Tier", per
Discord's API reference), so a post sits at 65.5% of it. `PAYLOAD_REJECTED` in `discord.ts`
self-heals an overflow by retrying text-only, but that headroom is what anything raising the grid's
pixel count spends. A third row, a wider cell, or a third attachment all come out of the same
3.45 MiB, and the failure mode without checking first is a 400 in production that costs every post
its images.

## No cache

`renderDeckGrid` renders straight through, every call, with nothing memoized. An earlier version
kept an LRU of finished grids keyed by the deck's ordered mirror filenames, on the theory that
players repeat decks constantly. That theory was true across ticks and irrelevant within one.
**Deno Deploy cold-starts this app on essentially every cron tick.** It runs the app as a standard
Deno process in a Linux microVM and stops an idle instance after as little as 5 seconds, so at one
tick a minute no module-level state survives from one tick to the next, regardless of what this
module does. See [Architecture](../.claude/CLAUDE.md#architecture) for the `onListen` evidence
behind that. A cache built to skip re-rendering repeated decks was paying upkeep against reuse that
could never happen.

Within a single tick, the ceiling on renders is `2 * targets`: guarantee 1 caps a tick at one post
per player, and each post renders exactly two grids, one per side. (The `PAYLOAD_REJECTED` retry in
`discord.ts` posts `buildFallbackMessage`'s text-only body, which carries no images and renders
nothing, so it never adds to this.) The only way a cache could ever hit inside that ceiling is an
intra-tick duplicate, either two tracked players landing in the same battle or a true mirror match.
That saves at most two renders, worth roughly 65 ms of CPU at the ~33 ms/render figure in the
[sharp runtime config](#sharp-runtime-config) table, on the rare ticks where it happens at all.
That's a few percent of what the valibot bundling described in `.claude/CLAUDE.md` saves on _every_
tick, for the cost of an LRU, its eviction policy, `configureDeckCache`'s wiring into `main.ts`, and
the tests covering all of it. Not worth carrying.

If head-to-head battles between tracked players ever turn out to be common enough to matter, the
right fix is not this LRU back again. It's a bare `Map<string, Promise<Buffer>>` keyed the same way,
populated before awaiting and read by the second caller within the same tick, then discarded when
the instance stops at tick end. That's in-flight _dedupe_, not a _cache_: it collapses two
concurrent renders of the same deck into one, which is the only kind of reuse a cold-start-per-tick
world can ever pay back. About 10 lines, no eviction policy, no byte budget, nothing to tune.

**There is no per-tile cache either**, and that one needs no fix at all: `loadTile` reads the same
handful of files out of `images/` on every render, and the OS page cache already serves them from
memory after the first read. A tile memo would duplicate the kernel's work in the instance's heap,
inside an instance that only lives for one tick.

## CDN fallback

`loadTile` reads from the local `images/` mirror first; a `NotFound` (a card released after the
last mirror sync) falls back to fetching the card's icon from the CDN via `fetchTile`, aborting
after `ICON_TIMEOUT_MS = 10_000` ms so a hung fetch can't stall the cron tick.

**Trim before resize, never the reverse.** `fetchTile` decodes the fetched icon, trims it to its
opaque art bounds exactly like the local path does, and _only then_ checks whether the trimmed
tile still overflows the cell, resizing only if it does. `CELL_WIDTH`/`CELL_HEIGHT` bound every
local icon's **trimmed** size (that's precisely what `pnpm measure` reports), not its raw
canvas size. If you instead fit the untrimmed canvas to the cell, the resize scales the
transparent margin down together with the art. A CDN tile whose art needed no scaling at all would
still come out visibly smaller than its local-mirror neighbors, because part of the "size" it was
fit against was empty padding. Trimming first means the resize (when it happens) only ever acts on
real art, matching how every local tile is sized.

The clamp still has to exist even though it rarely fires: the CDN has no size guarantee (a
brand-new card's art may simply be bigger than the cell even once trimmed), and `renderDeckGrid`'s
overlay math assumes every tile fits inside its cell. An oversized tile pushes the computed
`left`/`top` negative, which sharp clips silently instead of raising an error. `fit: "inside"`
preserves aspect ratio. No `withoutEnlargement` guard is needed on this resize, because the branch
only runs once the trimmed tile is already confirmed to exceed the cell, so the resize always
shrinks, never enlarges.

**Missing evo/hero variant art throws, it doesn't substitute.** `iconUrl` throws when a card's
`evolutionLevel` is set but the API lists no matching `evolutionMedium`/`heroMedium` variant,
rather than silently falling back to the card's un-evolved `medium` art. That fallback would be the
_wrong picture_, not a neutral placeholder. It would show an Evolution or Champion card wearing its
base frame, with no signal anything was off. The throw propagates out of `loadTile` and rejects the
whole `renderDeckGrid` call. `discord.ts` already catches a failed render and posts the text-only
fallback, so a missing variant costs the post its images (same as any other render failure), not one
tile its correctness.
