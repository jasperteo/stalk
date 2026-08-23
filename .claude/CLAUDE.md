# CLAUDE.md

Guidance for Claude Code when working in this repository.

**stalk** is a Deno app on Deno Deploy (Hono for HTTP): `Deno.cron` polls Clash Royale players'
battle logs every minute via the RoyaleAPI proxy and posts each player's newest 1v1 result to their
Discord webhook, with a composited deck-grid image per side. See [README.md](../README.md) for setup
and deployment.

## Commands

```sh
deno task dev     # Local dev server (-P loads deno.jsonc's "permissions" set)

deno task test     # Vitest suite
deno task preview  # Render a hardcoded deck to scripts/preview.png (manual, offline)
deno task measure  # Report card icons' transparent margins (no args = every icon + aggregate)

deno task fmt         # oxfmt
deno task lint        # oxlint && deno lint && deno check --unstable-tsgo .
deno task lint-agent  # Same three checks, oxlint in --format=agent — prefer this one as an agent
deno task sync-types  # Regenerate deno.d.ts (run when the Deno version changes)
```

**`deno task lint` (or its agent-formatted twin `deno task lint-agent`) is the single check
command.** Do not run a separate `tsc --noEmit` or a standalone `deno check`. The task already
chains oxlint (type-aware, via oxlint-tsgolint), `deno lint` (Deno-idiom rules), and
`deno check --unstable-tsgo`. CI (`.github/workflows/ci.yml`) runs `deno ci`,
`deno task fmt --check`, `deno task lint`, and `deno task test`.

## Guarantees

Break one of these and the app misbehaves in a way tests may not catch.

1. **At most one battle posts per tick, and it is the newest one.** Intermediate battles are
   skipped by design; lastBattle jumps straight to the newest. This is the delivery contract, not a
   validation shortcut: it keeps a tick to one fetch, one full validation, one post per player.
2. **lastBattle advances only after a successful post** (`poll.ts`). At-least-once delivery: if the
   webhook succeeds but the KV put throws, the next tick re-posts a duplicate rather than dropping
   the battle.
3. **Neither `poll()` nor `pollAll()` ever rejects.** `poll()` catches its own errors and resolves a
   `POLL_OUTCOMES` value, which is why `pollAll` uses `Promise.all` rather than `allSettled`. One
   player's failure can't sink the others. `pollAll` also catches the lastBattle read, the one
   failure that precedes every poll, reporting every target `failed`. `main.ts`'s cron handler
   awaits `pollAll` with no catch of its own, so an `await` added to `pollAll` outside that try
   reintroduces a rejected tick and loses the tally line.
4. **A tick reads every lastBattle value in one KV command.** `pollAll` calls
   `listLastBattles()` once and hands each `poll()` its own lastBattle value; nothing in the polling
   path may go back to a per-player `kv.get`. KV reads are the free tier's binding limit
   (450k/month) and a per-player read at one tick a minute burns ~43.8k of them per player per
   month. Writes stay per-tag, so concurrent polls never share a value.
5. **`images/` is a deploy-required asset.** The renderer hard-depends on it in production; CDN
   fetch is only a fallback for a card id with no local file. 180 PNGs (285×420): `<id>.png` plus 42
   `-evo` and 16 `-hero` variants, covering all 122 playable cards.
6. **Everything logs through `src/log.ts`.** It is the only module that may import
   `@std/fmt/colors`, so every paint call happens after its `setColorEnabled` gate.
7. **Every webhook body serializes through `payloadJson` (`discord.ts`).** It is what attaches
   `allowed_mentions: { parse: [] }`, and `content` carries an opponent display name chosen by a
   stranger. A new payload shape that calls `JSON.stringify` directly re-enables `@everyone` parsing
   on that name, and the existing tests only cover the two shapes that exist today.

### Known ceilings

Neither is a problem at the current scale; both are recorded so the next person doesn't have to
re-derive them.

- **`pollAll`'s fan-out is unbounded** (`Promise.all` over every target). Each in-flight post holds
  **~28 MB of pixels**. Per grid that is ~3.83 MB of decoded tiles (8 × 285×420×4) plus ~3.38 MB
  of trimmed copies plus the 3.43 MB composed canvas plus the 3.44 MB encoded PNG, ~14 MB, and a post
  carries two. Measured, not just derived: marginal peak RSS is 28 MiB per concurrent post from 1
  to 8 posts, easing to ~21 MiB at 16 as GC keeps up over the longer wall time, and 16 concurrent
  posts peak at 429–483 MiB RSS. So instance memory runs out first, somewhere around
  **15 targets**, well before CPU or the KV read budget. The figure is post-`toBuffer()`, which
  removed a transient duplicate that used to stack on top of it. See
  [Output method](../docs/deck-rendering.md#output-method-tobuffer-vs-touint8array). The fix, when
  it's needed, is `pooledMap` from `@std/async/pool`: already an installed dependency, zero runtime
  imports (so it costs nothing at module eval, same as `@std/async/lazy`), and it yields in input
  order, so `pollAll`'s index-aligned return survives. Note that it reports errors as an
  `AggregateError`, harmless only because guarantee 3 keeps `poll()` from ever rejecting, which
  would become the thing keeping that safe.
- **A post ships 6.55 MiB of attachments against Discord's 10 MiB default**, or 65.5%, and
  `PAYLOAD_REJECTED` self-heals an overflow by retrying text-only. See
  [the deck-rendering doc](../docs/deck-rendering.md#output-size) before raising the grid's pixel
  count.

## Architecture

Deno Deploy runs the app as a standard Deno process in a Linux microVM and stops an idle instance
after as little as 5 seconds, so at one tick a minute the app cold-starts on essentially every tick
and no module-level state survives from one tick to the next. The evidence is `Deno.serve`'s
`onListen` callback, which logs on every tick in production and only fires when the listener binds,
once per module evaluation. This is the premise behind the valibot bundling argument in
[Dependencies](#dependencies) (module eval cost is paid every tick, not once) and the reason
`src/deck-image.ts` keeps no render cache (see [Deck rendering notes](#deck-rendering-notes) and
[the deck-rendering doc](../docs/deck-rendering.md#no-cache)).

Cron tick → `config` (from `env.ts`, validated once at module load; `undefined` when the token is
missing, which logs a heartbeat and skips) → `pollAll(targets, token)` → one `listLastBattles()`
read → `poll()` per player concurrently → fetch
battle log → compare newest eligible battle against the stored lastBattle value → post → advance
lastBattle.

| File                  | Role                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`         | Wiring only. Runs as a script (`deno run`, not `deno serve` — hence no default export). `Deno.serve` binds Hono (`GET /` health, `GET /kv/last-battle` lastBattle dump); `Deno.cron` drives polling and logs a per-tick outcome tally.                                                                                                      |
| `src/poll.ts`         | The polling domain. Owns the KV handle (private; reads go through `listLastBattles()`) and the `["lastBattle", tag]` key with its 30-day TTL. `pollAll` is the tick entry point: one lastBattle read, then a concurrent `poll()` per target, each resolving one of `POLL_OUTCOMES`: `posted` / `seeded` / `skipped` / `drifted` / `failed`. |
| `src/clash-royale.ts` | Battle-log fetch via the RoyaleAPI proxy, with an abort timeout. `latestBattle` takes the first eligible entry (the log arrives newest-first, with 2v2s and Duels excluded) and fully validates only that one.                                                                                                                              |
| `src/discord.ts`      | Builds and posts the webhook message: content line (result, crowns, HP margin — doubles as the push notification), then one embed per side with deck grid, trophies, and tower-troop thumbnail.                                                                                                                                             |
| `src/deck-image.ts`   | Composites cards into a bottom-aligned 4-column PNG grid via sharp.                                                                                                                                                                                                                                                                         |
| `src/schema.ts`       | Valibot schemas for the API shapes and both env vars. `isEligibleBattle` rejects 2v2s and Duels (a Duel concatenates 2–3 decks into one `cards` array) before full validation. Normalizes CR's compact ISO 8601 timestamps and canonicalizes tags to `#UPPERCASE`.                                                                          |
| `src/env.ts`          | Reads and validates env once at module load; exports `config`.                                                                                                                                                                                                                                                                              |
| `src/log.ts`          | Leveled console wrapper (`info`/`success`/`warn`/`error`/`debug`), plus `levelColor` (badge palette), `hl` (inline value highlighters), and `ERROR_BODY_CHARS` (upstream error-body truncation cap, shared with `clash-royale.ts`).                                                                                                         |

Internal imports use the `@/` map with explicit `.ts` extensions.

### Failure behavior

- **Corrupt KV lastBattle value.** Logs a warning and re-seeds like a first run, rather than
  re-posting every tick against a value that can never match. An expired lastBattle value re-seeds
  silently.
- **lastBattle read fails.** The tick reports every target `failed` and polls nobody. Falling
  through with an empty map would be far worse: every player would read as a first run and get
  seeded past their newest battle without a post.
- **Schema drift.** The newest entry selected but failing full validation resolves `drifted`, not
  `skipped`, so it doesn't read as a quiet tick. lastBattle stays put and the battle retries once
  the schema catches up. An entry whose `team[0].cards` is missing or not an array, or that doesn't
  carry exactly one `opponent`, fails the eligibility check during the battlelog scan itself, before
  anything is selected as newest. That resolves `skipped`, not `drifted`, a small accepted
  narrowing of drift detection. `EligibleBattleSchema` (`src/schema.ts`) carries why the `opponent`
  check earns that narrowing.
- **A battle older than the stored lastBattle.** `poll.ts` compares the two as `Temporal.Instant`s
  and refuses to move lastBattle backwards: it warns and resolves `skipped`. Only reachable if the
  battlelog's newest-first ordering breaks; see the guard in `poll.ts` for what that would cost.
- **Deck render fails.** `discord.ts` posts a text-only embed instead.
- **Evo/Hero card missing its CDN variant art.** `iconUrl` (`deck-image.ts`) throws rather than
  silently substitute the card's un-evolved `medium` art, which would be the wrong picture, not a
  neutral fallback. The throw rejects the whole `renderDeckGrid` call, so this is a deck render
  failure like any other. One missing variant costs the post its images, not one tile its
  correctness.
- **Discord rejects the payload (400/413, `PAYLOAD_REJECTED`).** Retries once with the text-only
  body, so an oversized post self-heals. A 5xx/429 still throws: Discord may already have accepted
  it, and retrying could double-post.

### Deck rendering notes

[`docs/deck-rendering.md`](../docs/deck-rendering.md) is the authority on every constant's value and
rationale. The source carries a short JSDoc per constant, with an `@see` anchor back to the
relevant section where one exists. What to know before editing:

- **Tiles are never individually resized.** They composite at native resolution into fixed
  `CELL_WIDTH`×`CELL_HEIGHT` cells, so the grid's pixel dimensions stay constant across decks. The
  composed grid is encoded directly, with no scaling step at all, so the grid ships at its native
  resolution. Width, height, and row tops all come from the pure `planGrid(tileCount)` function,
  with no sharp involvement, so the layout math is unit-testable without rendering pixels.
  See [Cell sizing](../docs/deck-rendering.md#cell-sizing) and
  [Output size](../docs/deck-rendering.md#output-size).
- **Stay in raw memory, and stay on `Buffer`.** Tiles decode once to raw RGBA; `cropRaw` slices by
  memcpy rather than running a second sharp pipeline. Every pixel buffer inside the module is a
  `Buffer`: `RawImage.data`, `Tile.data`, `cropRaw`'s return, `renderDeckGrid`'s. That is what
  keeps them assignable to `.composite()`'s `OverlayOptions.input` and to `BlobPart` without a cast.
  `Uint8Array` appears only on inbound parameters, which accept a `Buffer` anyway. The mechanism is
  `toBuffer()`, never `toUint8Array()`: the two differ only in a native branch, and switching every
  output site cut peak RSS 2.4× with no change in render time or output bytes. See
  [Output method](../docs/deck-rendering.md#output-method-tobuffer-vs-touint8array).
- **No cache.** `renderDeckGrid` renders straight through every call; an earlier LRU keyed by the
  deck's ordered mirror filenames was deleted because the cold-start-per-tick fact above means
  cross-tick reuse, its whole premise, can't happen. See
  [No cache](../docs/deck-rendering.md#no-cache) for the ceiling on same-tick reuse and the cheap
  fallback (in-flight dedupe) if that ever turns out to matter. There is no per-tile cache; the OS
  page cache covers local reads.

## Toolchain

### Two TypeScript configs, deliberately

oxlint and Deno need different libs, so neither config can be dropped:

- **`tsconfig.json`.** oxlint and tsgolint read it (vanilla TypeScript). Sets no explicit `lib`, so
  `target: "esnext"` pulls TS's default full lib (DOM included) for web globals; `Deno.*` resolves
  through the vendored `deno.d.ts`.
- **`deno.jsonc` `compilerOptions`.** `deno check` and `deno run` read it. Sets
  `lib: ["deno.window", "deno.unstable"]` so the real `Deno` namespace (incl. `Deno.cron`,
  `Deno.openKv`, `Temporal`) resolves. Without it, Deno falls back to `tsconfig.json`, whose lib
  drops `deno.ns`.

`deno.d.ts` is a vendored copy of Deno's own `lib.deno.d.ts`, consumed only as ambient types. It's
excluded from `deno check`/`deno lint` (`deno.jsonc`) and from oxlint's file walk
(`oxlint.config.ts` `ignorePatterns`) so it's never linted or double-declared. Re-sync with
`deno task sync-types` after a Deno version bump.

### Dependencies

Runtime deps live in **`package.json`**, not `deno.jsonc`. The `imports` map holds only the `@/`
alias. A JSR-only package is declared with a bare `jsr:` specifier (`"@std/async": "jsr:^1.5.0"`,
`"@std/fmt": "jsr:^1.0.10"`); Deno resolves `jsr:` specifiers natively and materializes them into
`node_modules/@std/*` (symlinked into `node_modules/.deno`), and `preferPackageJson` makes
`package.json` the source of truth. This way both Deno and oxlint/tsgolint (which only understands
`node_modules`, not Deno's import map) resolve the same specifiers with no separate materialization
step. Run `deno install` after cloning.

**Prefer the npm-native package wherever one exists.** `valibot` and `hono` are deliberately _not_
declared with `jsr:` specifiers, and moving them back to "match `@std/fmt`" is a silent cold-start
regression, not a consistency fix. JSR publishes transpiled source with the original file layout,
so the JSR mirror of valibot is 557 separate modules behind a single barrel export, and since its
`exports` map has exactly one entry, `import * as v` resolves, links and evaluates all 557. The npm
package ships a pre-built self-contained `dist/index.mjs` instead: one module, same 311 exports.
Measured module-eval cost **29.8 ms → ~2–4 ms**, which at one cron tick a minute is ~2.5% of the
free tier's monthly CPU budget.

The rule generalizes by _entry-point shape_, not by registry: bundling only helps a library whose
entry is a single barrel over its whole export list. `hono` ships unbundled on npm too (372 files,
75 subpath exports, a 120-byte root entry), so importing it reaches only a couple dozen modules and
the packaging barely matters. It moved for consistency, worth ~0.7 ms. `@std/fmt` stays on `jsr:`
because it has no npm publication at all, and it costs nothing regardless: its four subpath entries
are already self-contained single files with zero relative imports.

`@std/async` fits the same doctrine with no new reasoning needed. Only `Lazy` is used, from
`deck-image.ts`, and `@std/async/lazy` is the same self-contained shape as `@std/fmt`'s subpath
entries, not valibot's JSR-mirror barrel: its `lazy.js` has zero runtime imports and defines a
single class. Its package-level deps (`@std/data-structures`, `@std/assert`, `@std/internal`) land
in `deno.lock`'s install graph, but nothing imports them, so they never enter the module graph.
They are install cost only.

`sharp` is the one dependency with a native component, a libvips addon shipped via
platform-filtered `optionalDependencies` (Deno Deploy resolves the linux binaries from `deno.lock`
at deploy time).
Three gotchas:

- **Its ESM entry exports only `default` at runtime.** The named exports its `.d.mts` declares
  (`cache`, `format`, …) do not exist in `dist/index.mjs`. Always go through the default:
  `sharp.cache(false)`, never `import { cache } from "sharp"`.
- **It is loaded lazily through a `Lazy`** (`sharpModule` in `deck-image.ts`). `Lazy` was picked
  for its rejection semantics rather than the memo alone. It clears its state when the initializer
  rejects, so the next render retries. Caching the rejection would let one transient dlopen
  failure silently poison every later render for the instance's lifetime.
- **`toUint8Array()` is `toBuffer()` plus a memcpy.** The name suggests a different return shape;
  both resolve a `Buffer` on Deno, and its `.d.mts` declares the wider `Uint8Array<ArrayBufferLike>`
  that `BlobPart` rejects. Nothing in the codebase calls it. See the deck-rendering notes above.

`@types/node` is a devDependency because the oxlint pass needs it for sharp's `Buffer`/`NodeJS.*`
references (`deno check` doesn't).

**The `@/` alias is declared in three places that must stay in sync:** `deno.jsonc` `imports`,
`tsconfig.json` `paths`, and vitest via `resolve: { tsconfigPaths: true }` in `vitest.config.ts`.

## Testing

Vitest runs **inside the Deno process**, so `Deno.*` (KV, cron, env) is the real ambient global and
tests spy on it directly rather than mocking a wrapper. `environment: "node"` only selects vitest's
non-DOM global set. It says nothing about the underlying runtime. Discovery is scoped to
`dir: "./src"` (skips walking `images/` and `scripts/`). `restoreMocks`/`clearMocks`/`unstubGlobals`/
`unstubEnvs` are all on; no test uses `.concurrent`, since several mutate shared `globalThis` state.

- `src/testing/kv.ts` holds `spyMemoryKv()`, the shared `Deno.openKv` spy. It redirects a module's
  top-level `await Deno.openKv()` to a fresh `:memory:` store and closes it via `onTestFinished`, so
  the handle stays scoped to the test that opened it. Call it from inside a test body, never a hook.
- `src/testing/fixtures.ts` holds raw (pre-validation) API shapes: `rawCard`/`rawPlayer`/`rawBattle`
  factories, so a test overriding one field doesn't restate the rest; `driftedBattle` and
  `duelBattle`, same-shaped factories for the two rejection paths; and the `BOB`/`WEBHOOK`
  constants.
- `src/__mocks__/log.ts` is the manual mock auto-applied by a factory-less
  `vi.mock(import("@/log.ts"))`; `vitest/prefer-import-in-mock` enforces that form over a path
  string everywhere. One canonical copy of the export list: a new export from `log.ts` means one
  edit here, not one per test file.
- `src/deck-image.test.ts` uses a default tile fixture that is **fully opaque**, so most tests
  exercise `trimToArt`/`cropRaw` with the crop equal to the whole frame. `describe("trimToArt")`
  covers a real crop via `insetFixture`. What stays uncovered is real card art, so verify crop
  changes against it (`deno task preview`, or diff `cropRaw` against `sharp().extract()` across
  `images/`).

**A throwaway probe script that imports project deps must live inside the repo root.** Deno resolves
`node_modules` from there, so `deno run -A /tmp/probe.ts` fails with `Import "sharp" not a
dependency`. Use `scripts/` (its `*.png` output is gitignored) and delete the probe afterward.

## Code style

- **Tabs** for indentation, trailing commas in ES5 positions (both enforced by oxfmt).
- **Imports** sorted ascending, case-insensitive, grouped with blank lines: side effects → builtins
  → external → internal (`@/`) → relative.
- **No ambient globals for runtime values.** Import them (`import { Buffer } from "node:buffer"`,
  in the builtins group), even where Deno's node compat resolves the bare global and lint stays
  green. Genuine platform globals (`fetch`, `Response`, `Deno.*`, `Temporal`, `performance`) are
  fine.
- **Exports gathered at the bottom** of each module: plain declarations in the body, then a sorted
  `export { … }` plus a separate `export type { … }`. No inline `export` on declarations. A module
  whose export list is mostly not production API may split the value exports into a production
  group and an `@internal` group (`deck-image.ts`, `discord.ts`), sorted within each.
- **Return types and generic type arguments are inferred by default.** Write one explicitly only
  when inference would produce a worse type: it erases a named alias from hover
  (`Promise<BattleLog>` → `Promise<unknown[]>`), widens a literal union (`PollOutcome` → `string`),
  or launders `any` into `unknown`. Otherwise it is noise. `new Lazy(init)` infers `T` from the
  initializer's return type exactly as a function infers its own, and a cast or a callee's own
  annotation usually carries the alias through already.
- oxlint runs the `typescript`, `unicorn`, `oxc`, and `jsdoc` plugins with type-aware checking
  (`options: { typeAware: true, typeCheck: true }`). Categories are set globally,
  `correctness: "error"` and `perf: "warn"`, on top of a long explicit rule list; `**/*.test.ts`
  adds the `vitest` plugin via an override. `jsdoc` contributes only `check-property-names` and
  `check-tag-names`, both at `warn`: they catch a misspelled or invented tag, and deliberately
  mandate no coverage. Add a tag only where it carries something the name and type don't.
