# Deck rendering tuning log

`src/deck-image.ts` composites a Clash Royale deck into a single PNG grid via
[sharp](https://sharp.pixelplumbing.com/): each card's local art is trimmed to its
opaque bounds, placed into a fixed-size cell, and the finished grid is composed and encoded once,
at native resolution — there is no downscale step.
This doc is the authority on why each constant in that module has the value it does and what
breaks if you change it — the source carries only a one-line JSDoc per constant, pointing back
here. Organized by topic, not declaration order.

## Single pipeline

`composeDeckGrid` composes and encodes in one sharp pipeline: a `create` canvas, all tile overlays,
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

`loadSharp()` imports `sharp` lazily — on first render rather than at every isolate cold boot —
and memoizes the resolved module. Two calls follow immediately on load:

- **`sharp.cache(false)`** disables libvips' own operation cache. The deck LRU (see
  [Deck cache](#deck-cache)) is the only cache this module wants; libvips' cache would just hold
  memory redundantly.
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

Only a _successful_ load is memoized (`sharpModule ??= import(...).then(onSuccess, onFailure)`,
where the failure branch resets `sharpModule = undefined` before rethrowing). Caching the rejection
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

`composeDeckGrid` also warns at render time when a specific tile's `bottomPadding` is smaller than
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

**Moves together with `DECK_CACHE_BYTES`** — see [Constants that move together](#constants-that-move-together).

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
carries two grids, one per side — and 5× the cache memory per cached grid (see
[Deck cache](#deck-cache)). Discord renders embed images at a few hundred px wide regardless, so
none of the extra resolution is actually visible; the trade only pays off because CPU, not upload
bytes, is what Deno Deploy bills.

## Deck cache

`renderDeckGrid` caches finished grids in an LRU keyed by the deck's ordered mirror filenames, so a
repeated deck (players repeat decks constantly) skips rendering entirely. It's the only cache in
this module — per-tile local reads are already covered by the OS page cache.

`DECK_CACHE_BYTES = 28 * 1024 * 1024` (28 MiB) is a **byte** budget. Duels are filtered out before
rendering (`src/schema.ts` rejects any entry whose `team[0].cards` has more than 8 entries), so
every cached grid is now the same size: an 8-card grid is 3.28 MiB at native resolution (see
[Output size](#output-size)), and 28 MiB holds roughly **8 grids** — four posts' worth, since a post
carries two grids, one per side. Entry size no longer varies several-fold the way it did when duel
grids (up to 24 cards) shared the cache, so entry count is now a much better proxy for cache memory
than it used to be.

There's also a secondary **entry-count guard**, `deckCacheLimit`, defaulting to
`DECK_CACHE_MIN_ENTRIES = 8` so it's sane with no configuration at all (offline scripts, tests). `8`
isn't arbitrary — it's exactly what `DECK_CACHE_BYTES` affords at the current grid size (see the
roughly-8-grids figure above), so the byte budget and the entry-count floor agree instead of one
being permanently unreachable. `configureDeckCache(targetCount)`, called once from the composition
root (`main.ts`), raises it to `3 * targetCount + 8` — sized so that growing the tracked-player list
(`TARGETS`) keeps each player's own decks warm plus headroom for opponents' decks, without the
renderer needing to read app config directly.

At the current grid size the byte budget is what actually binds — it evicts before the entry count
ever reaches the floor. The entry guard is a deliberate hedge, not a leftover: it's there for when
`GRID_COMPRESSION` is raised off `0` (see [Encoding](#encoding)), which shrinks every cached grid
several-fold — the same 8-card grid drops from 3.28 MiB at level 0 to 1.42 MiB at level 6 — and at
that point entry count, not bytes, becomes the real bound. That's why `deckCacheLimit`'s floor moves
together with `GRID_COMPRESSION`; see [Constants that move together](#constants-that-move-together).

Eviction (`evictDeckCache`) removes from the front of the map (oldest / least-recently-used) until
_both_ the byte budget and the entry-count guard are satisfied.

**Moves together with `GRID_COMPRESSION`** — see [Constants that move together](#constants-that-move-together).

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
brand-new card's art may simply be bigger than the cell even once trimmed), and `composeDeckGrid`'s
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

## Constants that move together

These were tuned as units, not independently. Changing one half without the other reintroduces the
problem the pair was tuned to solve:

- **`GRID_COMPRESSION` ↔ `DECK_CACHE_BYTES`.** Raising compression (moving off level 0) means
  lowering the cache byte budget to match, and vice versa — smaller encoded grids mean more of them
  fit in the same budget. These were changed together historically: dropping `GRID_COMPRESSION` to
  0 made every grid roughly **1.8×** bigger, so `DECK_CACHE_BYTES` rose from **12 MiB to 22 MiB** in
  the same change. Holding the budget flat while dropping compression would have cut effective cache
  capacity to roughly 18 decks and spent the saved encode CPU straight back on cache-miss
  re-renders — the exact cost the compression change was trying to avoid.

  `DECK_CACHE_BYTES` moved again, for a related reason, when the grid stopped being scaled down
  before shipping (see [Output size](#output-size)): removing that stage made every cached grid
  **5×** bigger (0.65 MiB → 3.28 MiB), so `DECK_CACHE_BYTES` rose again, from **22 MiB to 28 MiB**.
  Unlike the first bump, nothing on the `GRID_COMPRESSION` side offset this one, so effective cache
  capacity dropped hard, from roughly 33 decks to roughly 8 — an accepted cost of shipping full
  resolution, not an oversight.

- **`GRID_COMPRESSION` ↔ `DECK_CACHE_MIN_ENTRIES`.** The entry-count floor (see
  [Deck cache](#deck-cache)) is set to what `DECK_CACHE_BYTES` affords at the current grid size, so
  it doesn't bind today — the byte budget always evicts first. Raising `GRID_COMPRESSION` shrinks
  every cached grid several-fold, which raises the true entry ceiling well past 8; leaving
  `DECK_CACHE_MIN_ENTRIES` at 8 in that world would silently strand most of the freed byte budget
  unused. The floor needs to move with compression, even though its own value doesn't appear in the
  compression math directly.
