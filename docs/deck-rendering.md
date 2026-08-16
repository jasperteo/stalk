# Deck rendering tuning log

`src/deck-image.ts` composites a Clash Royale deck into a single PNG grid via
[sharp](https://sharp.pixelplumbing.com/): each card's local art is trimmed to its
opaque bounds, placed into a fixed-size cell, and the finished grid is composed and encoded once,
at native resolution — there is no downscale step.
This doc is the authority on why each constant in that module has the value it does and what
breaks if you change it — the source carries a short JSDoc per constant, with an `@see` anchor back
to the relevant section where one exists. Organized by topic, not declaration order.

## Single pipeline

`renderDeckGrid` composes and encodes in one sharp pipeline: a `create` canvas, all tile overlays,
and `.png(...)`, in a single `sharp({ create }).composite(overlays).png(...)` call — no resize
stage, no intermediate raw-bitmap round trip. That's only possible because the grid now ships at
native resolution (1080 px wide for 4 columns): there's nothing left to scale after compositing.

This module used to need a second pipeline for exactly that reason. sharp applies `resize` before
`composite` within a single pipeline regardless of the order the methods are chained in code, so
scaling the _finished_, already-composed grid down could never happen in the same pipeline that
composed it — doing so would run the resize first, against an empty canvas, and every tile overlay
would land at the wrong scale. The extra pass existed solely to serve the downscale described in
[Output size](#output-size); once the grid stopped downscaling, compose and encode fused into the
single pipeline above.

## sharp runtime config

`sharpModule`, a `Lazy` from `@std/async` holding sharp's constructor, imports `sharp` lazily — on
first render rather than at every isolate cold boot — and memoizes the resolved module. Two calls
follow immediately on load:

- **`sharp.cache(false)`** disables libvips' own operation cache. This module keeps no cache of its
  own either (see [No cache](#no-cache)) — Deno Deploy gives the app a fresh isolate per cron tick,
  so libvips' cache can never accumulate a hit across renders that matter; it would only hold memory
  it never reuses.
- **`sharp.concurrency(1)`** collapses libvips' per-pipeline thread pool to a single thread, trading
  wall time for total CPU. This is a cron job — nothing is waiting synchronously on one render, so
  wall time is nearly worthless while CPU time is what Deno Deploy bills. `loadTile` already runs
  every tile through `Promise.all`, so all 8 pipelines of a deck are in flight concurrently
  regardless; letting each of those _also_ spawn its own thread pool is pure oversubscription.
  Collapsing to 1 thread removes only the redundant intra-pipeline threading — the app-level
  (inter-pipeline) parallelism is untouched.

Measured locally (default pool size 5, 20 renders, user+sys time summed across all threads):

| Deck        | CPU-seconds (pool 5 → concurrency 1) | Wall time (pool 5 → concurrency 1) |
| ----------- | ------------------------------------ | ---------------------------------- |
| 8-card deck | 1.14 → 0.84 (~25% less)              | 10 → 17 ms                         |

Kernel time nearly halves under `concurrency(1)`, which is the thread-coordination overhead this
removes. `sharp.concurrency(2)` is the documented hedge if wall time ever starts to matter: it
captures most of the CPU win for roughly half the added latency. **Revisit this whole trade if Deno
Deploy ever bills isolate wall time rather than CPU — the trade inverts.**

Only a _successful_ load is memoized, which is why `Lazy` is used rather than a bare promise memo:
it clears its state when the initializer rejects, so the next render retries. Caching the rejection
instead — the bare `sharpModule ??= import(...)` shape — would let one transient dlopen failure
poison every later render for the isolate's lifetime, and silently: `discord.ts` catches a failed
render and posts the text-only fallback, so the symptom would be decks quietly vanishing from every
post rather than a visible crash.

## Cell sizing

Tiles are never individually resized. Each card composites at native resolution into a fixed
`CELL_WIDTH` × `CELL_HEIGHT` cell, so the grid's pixel dimensions stay constant regardless of which
cards are in the deck — no per-deck layout recalculation, and no upscale blur on any one tile.

`CELL_WIDTH = 261`, `CELL_HEIGHT = 405` are set to the upper bound of every local icon's _trimmed_
size, as reported by `deno task measure`. Raising either shrinks nothing (cells just get emptier
padding); lowering either without re-measuring risks clipping the largest trimmed icon currently in
`images/`.

## Gaps and overlap

`COLUMN_GAP = 12` is the gutter between columns, in native pixels. Tiles are already trimmed on the
sides, so this is the true visual gap between adjacent cards.

`ROW_GAP = -16` is the gutter between rows, and it's negative on purpose: the upper row's
transparent bottom padding (the margin `trimRaw` kept below each card's art) is allowed to overlap
the row below, tightening the two rows together instead of leaving dead space under the shorter
cards. There's a floor around **-20** — past that, hexagon and champion frames (which sit lower in
their canvas than most cards) start to clip into the row below.

`renderDeckGrid` also warns at render time when a specific tile's `bottomPadding` is smaller than
`-ROW_GAP` — that's exactly the clipping condition the -20 floor exists to avoid, caught per-tile
rather than only in aggregate.

## Encoding

`GRID_COMPRESSION = 0` sets the shipped PNG's zlib `compressionLevel` (range 0–9). Level 0 is zlib
_stored_ — no compression at all — so the encode is effectively a memcpy and the output size is
exactly `width × height × 4` plus about 0.2% PNG framing overhead. It is still a valid, lossless
PNG: levels 0 and 6 decode to byte-identical pixels, so nothing about image quality changes, only
upload size and CPU.

With no resize stage (see [Single pipeline](#single-pipeline)), encode CPU can be measured directly
at native resolution — median of 11 renders on an 8-card deck, real composited grids of actual card
art:

| Compression | CPU     | Size     |
| ----------- | ------- | -------- |
| level 0     | 1.6 ms  | 3.28 MiB |
| level 6     | 26.5 ms | 1.42 MiB |

Level 0 over level 6 buys ~24.9 ms per grid at a cost of ~1.86 MiB more per grid — a far more
lopsided case for level 0 than it used to be when a resize sat between compose and encode, since
that stage shrank the pixel count before deflate ever ran, narrowing the gap between the two
levels. With nothing shrinking the pixel count anymore, level 0 is an unambiguous win on the CPU
axis Deno Deploy actually bills.

## Output size

The deck grid ships at native resolution — 1080 px wide for 4 columns, no downscale step. An
8-card deck's grid — the only deck size that reaches rendering, since `src/schema.ts` filters duels
out during the battlelog scan, before validation and before any rendering — is 3.28 MiB at
`GRID_COMPRESSION = 0` (see [Encoding](#encoding)).

The grid used to be scaled down before shipping, in a second pass over the already-composed bitmap
(see [Single pipeline](#single-pipeline)). That stage was removed for CPU, not size — measured end
to end (compose + encode, median of 21 renders on an 8-card deck):

| Pipeline                                   | CPU     | Size     |
| ------------------------------------------ | ------- | -------- |
| two-pipeline + resize (old)                | 12.2 ms | 0.65 MiB |
| two-pipeline, no resize                    | 9.1 ms  | 3.28 MiB |
| fused single pipeline, no resize (current) | 7.9 ms  | 3.28 MiB |

The resize barely paid for its own encode-side savings: at `GRID_COMPRESSION = 0`, a stored PNG has
no deflate to shorten, so downscaling first bought the encode pass almost nothing — the Lanczos
resample cost real CPU (12.2 ms vs 9.1 ms) for a compression stage that wasn't doing anything
size-sensitive to begin with. Once the resize was gone, compose and encode fused into one pipeline,
which shaved a further 1.2 ms by skipping the raw-bitmap round trip out of sharp and back in
(9.1 ms vs 7.9 ms).

This is a deliberate CPU-for-bytes trade, not a free win. Shipping at native resolution costs
roughly 5× the upload bytes per grid (3.28 MiB vs 0.65 MiB) — about 6.6 MiB per post, since a post
carries two grids, one per side. With no cache in this module (see [No cache](#no-cache)) there's no
cache-memory side of that cost anymore either — the trade is purely encode CPU against upload
bytes, which only strengthens the case for native resolution: less CPU, and the extra bytes buy
nothing visible, since Discord renders embed images at a few hundred px wide regardless.

**The budget those 6.6 MiB are spent against is Discord's 10 MiB default request limit** ("The
default limit is `10 MiB` for all users, but may be higher … by the server's Boost Tier" — Discord's
API reference), so a post sits at roughly 66% of it. Comfortable today, and `PAYLOAD_REJECTED` in
`discord.ts` self-heals an overflow by retrying text-only — but that headroom is what anything
raising the grid's pixel count spends. A third row, a wider cell, or a third attachment all come out
of the same ~3.4 MiB, and the failure mode without checking first is a 400 in production that costs
every post its images.

## No cache

`renderDeckGrid` renders straight through, every call, with nothing memoized. An earlier version
kept an LRU of finished grids keyed by the deck's ordered mirror filenames, on the theory that
players repeat decks constantly. That theory was true across ticks and irrelevant within one:
**Deno Deploy gives this app a fresh isolate per cron tick**, so no module-level state survives from
one tick to the next regardless of what this module does — see
[Architecture](../.claude/CLAUDE.md#architecture) for the `onListen` evidence behind that. A cache
built to skip re-rendering repeated decks was paying upkeep against reuse that could never happen.

Within a single tick, the ceiling on renders is `2 * targets`: guarantee 1 caps a tick at one post
per player, and each post renders exactly two grids, one per side. (The `PAYLOAD_REJECTED` retry in
`discord.ts` posts `buildFallbackMessage`'s text-only body, which carries no images and renders
nothing, so it never adds to this.) The only way a cache could ever hit inside that ceiling is an
intra-tick duplicate — two tracked players landing in the same battle, or a true mirror match —
which saves at most two renders, worth roughly 84 ms of CPU at the ~42 ms/render figure in the
[sharp runtime config](#sharp-runtime-config) benchmarks, on the rare ticks where it happens at all.
That's a few percent of what the valibot bundling described in `.claude/CLAUDE.md` saves on _every_
tick, for the cost of an LRU, its eviction policy, `configureDeckCache`'s wiring into `main.ts`, and
the tests covering all of it. Not worth carrying.

If head-to-head battles between tracked players ever turn out to be common enough to matter, the
right fix is not this LRU back again — it's a bare `Map<string, Promise<Uint8Array<ArrayBuffer>>>`
keyed the same way, populated before awaiting and read by the second caller within the same tick,
discarded with the isolate at tick end. That's in-flight _dedupe_, not a _cache_: it collapses two
concurrent renders of the same deck into one, which is the only shape of reuse a
fresh-isolate-per-tick world can ever pay back. About 10 lines, no eviction policy, no byte budget,
nothing to tune.

## CDN fallback

`loadTile` reads from the local `images/` mirror first; a `NotFound` (a card released after the
last mirror sync) falls back to fetching the card's icon from the CDN via `fetchTile`, aborting
after `ICON_TIMEOUT_MS = 10_000` ms so a hung fetch can't stall the cron tick.

**Trim before resize, never the reverse.** `fetchTile` decodes the fetched icon, trims it to its
opaque art bounds exactly like the local path does, and _only then_ checks whether the trimmed
tile still overflows the cell — resizing only if it does. `CELL_WIDTH`/`CELL_HEIGHT` bound every
local icon's **trimmed** size (that's precisely what `deno task measure` reports), not its raw
canvas size. If you instead fit the untrimmed canvas to the cell, the resize scales the
transparent margin down together with the art — so a CDN tile whose art needed no scaling at all
would still come out visibly smaller than its local-mirror neighbors, because part of the "size" it
was fit against was empty padding. Trimming first means the resize (when it happens) only ever
acts on real art, matching how every local tile is sized.

The clamp still has to exist even though it rarely fires: the CDN has no size guarantee (a
brand-new card's art may simply be bigger than the cell even once trimmed), and `renderDeckGrid`'s
overlay math assumes every tile fits inside its cell — an oversized tile pushes the computed
`left`/`top` negative, which sharp clips silently instead of raising an error. `fit: "inside"`
preserves aspect ratio; no `withoutEnlargement` guard is needed on this resize because the branch
only runs once the trimmed tile is already confirmed to exceed the cell, so the resize always
shrinks, never enlarges.

**Missing evo/hero variant art throws, it doesn't substitute.** `iconUrl` throws when a card's
`evolutionLevel` is set but the API lists no matching `evolutionMedium`/`heroMedium` variant,
rather than silently falling back to the card's un-evolved `medium` art. That fallback would be the
_wrong picture_ — an Evolution or Champion card shown wearing its base frame, with no signal
anything was off — not a neutral placeholder. The throw propagates out of `loadTile` and rejects
the whole `renderDeckGrid` call; `discord.ts` already catches a failed render and posts the
text-only fallback, so a missing variant costs the post its images (same as any other render
failure), not one tile its correctness.
