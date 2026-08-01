# CLAUDE.md

Guidance for Claude Code when working in this repository.

**stalk** is a Deno app on Deno Deploy (Hono for HTTP): `Deno.cron` polls Clash Royale players'
battle logs every minute via the RoyaleAPI proxy and posts each player's newest 1v1 result to their
Discord webhook, with a composited deck-grid image per side. See [README.md](../README.md) for setup
and deployment.

## Commands

```sh
deno task dev     # Local dev server (deno watch -A --tunnel; q + Enter quits)
deno task deploy  # Deploy to Deno Deploy (deployctl; org/app pinned in deno.json "deploy")

deno task test     # Vitest suite
deno task preview  # Render a hardcoded deck to scripts/preview.png (manual, offline)
deno task measure  # Report card icons' transparent margins (no args = every icon + aggregate)

deno task fmt         # oxfmt
deno task lint        # oxlint && deno lint && deno check --unstable-tsgo .
deno task sync-types  # Regenerate deno.d.ts (run when the Deno version changes)
```

**`deno task lint` is the single check command.** Do not run a separate `tsc --noEmit` or a
standalone `deno check` — the task already chains oxlint (type-aware, via oxlint-tsgolint),
`deno lint` (Deno-idiom rules), and `deno check --unstable-tsgo`. CI
(`.github/workflows/ci.yml`) runs `deno ci`, `deno task fmt --check`, `deno task lint`, and
`deno task test`.

## Invariants

Break one of these and the app misbehaves in a way tests may not catch.

1. **At most one battle posts per tick — the newest.** Intermediate battles are skipped by design;
   the cursor jumps straight to the newest. This is the delivery contract, not a validation
   shortcut: it keeps a tick to one fetch, one full validation, one post per player.
2. **The cursor advances only after a successful post** (`poll.ts`). At-least-once delivery: if the
   webhook succeeds but the KV put throws, the next tick re-posts a duplicate rather than dropping
   the battle.
3. **`poll()` never rejects.** It catches its own errors and resolves a `POLL_OUTCOMES` value, which
   is why `pollAll` uses `Promise.all` rather than `allSettled`. One player's failure can't sink the
   others.
4. **A tick reads every cursor in one KV command.** `pollAll` calls `listCursors()` once and hands
   each `poll()` its own cursor; nothing in the polling path may go back to a per-player `kv.get`.
   KV reads are the free tier's binding limit (450k/month) and a per-player read at one tick a minute
   burns ~43.8k of them per player per month. Writes stay per-tag, so concurrent polls never share a
   value.
5. **`if (interactive) await quitOnKeypress()` must stay the last statement in `main.ts`.** Its
   top-level await blocks module evaluation until stdin closes, so anything below it never runs
   locally — and Deploy (no TTY, skips the gate) would mask the breakage.
6. **`renderDeckGrid` uses two sharp pipelines, not one.** sharp always applies `resize` before
   `composite` within a single pipeline regardless of chaining order, so the finished grid can only
   be scaled over an already-composed bitmap. Collapsing the two pipelines silently drops every
   overlay from the output.
7. **`images/` is a deploy-required asset.** The renderer hard-depends on it in production; CDN
   fetch is only a fallback for a card id with no local file. 177 PNGs (285×420): `<id>.png` plus 41
   `-evo` and 14 `-hero` variants, covering all 122 playable cards.
8. **Everything logs through `src/log.ts`.** It is the only module that may import
   `@std/fmt/colors`, so every paint call happens after its `setColorEnabled` gate.

## Architecture

Cron tick → `config` (from `env.ts`, validated once at module load; `undefined` when the token is
missing, which logs a heartbeat and skips) → `pollAll(targets, token)` → one `listCursors()` read →
`poll()` per player concurrently → fetch
battle log → compare newest eligible battle against the KV cursor → post → advance cursor.

| File                 | Role                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`        | Wiring only. Runs as a script (`deno run`, not `deno serve` — hence no default export). `Deno.serve` binds Hono (`GET /` health, `GET /kv/last-battle` cursor dump); `Deno.cron` drives polling and logs a per-tick outcome tally.                                                                                                  |
| `src/poll.ts`        | The polling domain. Owns the KV handle (private; reads go through `listCursors()`) and the `["lastBattle", tag]` key with its 30-day TTL. `pollAll` is the tick entry point: one cursor read, then a concurrent `poll()` per target, each resolving one of `POLL_OUTCOMES`: `posted` / `seeded` / `skipped` / `drifted` / `failed`. |
| `src/clashroyale.ts` | Battle-log fetch via the RoyaleAPI proxy, with an abort timeout. `latestBattle` takes the first eligible entry (the log arrives newest-first) and fully validates only that one.                                                                                                                                                    |
| `src/discord.ts`     | Builds and posts the webhook message: content line (result, crowns, HP margin — doubles as the push notification), then one embed per side with deck grid, trophies, and tower-troop thumbnail.                                                                                                                                     |
| `src/deck-image.ts`  | Composites cards into a bottom-aligned 4-column PNG grid via sharp.                                                                                                                                                                                                                                                                 |
| `src/schema.ts`      | Valibot schemas for the API shapes and both env vars. Normalizes CR's compact ISO 8601 timestamps and canonicalizes tags to `#UPPERCASE`.                                                                                                                                                                                           |
| `src/env.ts`         | Reads and validates env once at module load; exports `config`.                                                                                                                                                                                                                                                                      |
| `src/log.ts`         | Leveled console wrapper (`info`/`success`/`warn`/`error`/`debug`), plus `levelColor` (badge palette) and `hl` (inline value highlighters).                                                                                                                                                                                          |

Internal imports use the `@/` map with explicit `.ts` extensions.

### Failure behavior

- **Corrupt KV cursor** — logs a warning and re-seeds like a first run, rather than re-posting every
  tick against a cursor that can never match. An expired cursor re-seeds silently.
- **Schema drift** — the newest entry selected but failing full validation resolves `drifted`, not
  `skipped`, so it doesn't read as a quiet tick. The cursor stays put and the battle retries once
  the schema catches up.
- **Deck render fails** — `discord.ts` posts a text-only embed instead.
- **Discord rejects the payload (400/413, `PAYLOAD_REJECTED`)** — retries once with the text-only
  body, so an oversized post self-heals. A 5xx/429 still throws: Discord may already have accepted
  it, and retrying could double-post.

### Deck rendering notes

The doc comments in `src/deck-image.ts` are the authority on every constant's value and rationale.
What to know before editing:

- **Tiles are never individually resized.** They composite at native resolution into fixed
  `CELL_WIDTH`×`CELL_HEIGHT` cells (261×405, the upper bound of every trimmed icon per
  `deno task measure`), so the pre-downscale grid dimensions stay constant across decks. Only the
  composed grid is scaled, as the last step before encoding (`MAX_GRID_WIDTH`, 480).
- **Stay in raw memory.** Tiles decode once to raw RGBA; `cropRaw` and `solidRule` slice/build
  `Buffer`s by memcpy rather than running a second sharp pipeline. They return `Buffer` because
  `OverlayOptions.input` is typed `Buffer`-only and must feed `.composite()` castless.
  `toUint8Array()` is the rule only for data _leaving_ sharp.
- **Duels** concatenate 2 or 3 decks into one `cards` array (16 or 24 entries), rendered as stacked
  blocks. `COLUMN_GAP`/`ROW_GAP` tune spacing _within_ a block; `DECK_GAP` and `DIVIDER_*` govern
  block boundaries. Tune the latter via `deno task preview` **on a 16-card deck** — an ordinary
  8-card deck has no block boundary and never exercises them.
- **One cache only:** an LRU of finished grids keyed by the deck's ordered mirror filenames, bounded
  primarily by `DECK_CACHE_BYTES` and secondarily by an entry-count guard that `main.ts` sizes once
  at startup via `configureDeckCache` (so the renderer never reads app config). There is no per-tile
  cache — local reads are covered by the OS page cache.

## Toolchain

### Two TypeScript configs, deliberately

oxlint and Deno need different libs, so neither config can be dropped:

- `tsconfig.json` — read by oxlint/tsgolint (vanilla TypeScript). Sets no explicit `lib`, so
  `target: "esnext"` pulls TS's default full lib (DOM included) for web globals; `Deno.*` resolves
  through the vendored `deno.d.ts`.
- `deno.json` `compilerOptions` — read by `deno check`/`deno run`. Sets
  `lib: ["deno.window", "deno.unstable"]` so the real `Deno` namespace (incl. `Deno.cron`,
  `Deno.openKv`, `Temporal`) resolves. Without it, Deno falls back to `tsconfig.json`, whose lib
  drops `deno.ns`.

`deno.d.ts` is a vendored copy of Deno's own `lib.deno.d.ts`, consumed only as ambient types — it's
excluded from `deno check`/`deno lint` (`deno.json`) and from oxlint's file walk
(`oxlint.config.ts` `ignorePatterns`) so it's never linted or double-declared. Re-sync with
`deno task sync-types` after a Deno version bump.

### Dependencies

Runtime deps live in **`package.json`**, not `deno.json` — the `imports` map holds only the `@/`
alias. JSR packages are declared as npm aliases (`"@hono/hono": "npm:@jsr/hono__hono@^4.12.31"`);
Deno resolves the `@jsr` scope natively (no `.npmrc`), and `preferPackageJson` makes `package.json`
the source of truth. This way both Deno and oxlint/tsgolint (which only understands `node_modules`,
not Deno's import map) resolve the same specifiers with no separate materialization step. Run
`deno install` after cloning.

`sharp` is the one plain npm dependency — a native libvips addon shipped via platform-filtered
`optionalDependencies` (Deno Deploy resolves the linux binaries from `deno.lock` at deploy time).
Two gotchas:

- **Its ESM entry exports only `default` at runtime.** The named exports its `.d.mts` declares
  (`cache`, `format`, …) do not exist in `dist/index.mjs`. Always go through the default:
  `sharp.cache(false)`, never `import { cache } from "sharp"`.
- **It is loaded lazily and memoized on success only** (`loadSharp` in `deck-image.ts`). A rejected
  load clears the slot so the next render retries; caching the rejection (the bare
  `sharpModule ??= import(…)` shape) would let one transient dlopen failure silently poison every
  later render for the isolate's lifetime.

`@types/node` is a devDependency because the oxlint pass needs it for sharp's `Buffer`/`NodeJS.*`
references (`deno check` doesn't).

**The `@/` alias is declared in three places that must stay in sync:** `deno.json` `imports`,
`tsconfig.json` `paths`, and vitest via `resolve: { tsconfigPaths: true }` in `vitest.config.ts`.

## Testing

Vitest runs **inside the Deno process**, so `Deno.*` (KV, cron, env) is the real ambient global and
tests spy on it directly rather than mocking a wrapper. `environment: "node"` only selects vitest's
non-DOM global set — it says nothing about the underlying runtime. Discovery is scoped to
`dir: "./src"` (skips walking `images/` and `scripts/`). `restoreMocks`/`clearMocks`/`unstubGlobals`/
`unstubEnvs` are all on; no test uses `.concurrent`, since several mutate shared `globalThis` state.

- `src/testing/kv.ts` — `spyMemoryKv()`, the shared `Deno.openKv` spy. Redirects a module's
  top-level `await Deno.openKv()` to a fresh `:memory:` store and closes it in an `afterEach`.
- `src/testing/fixtures.ts` — raw (pre-validation) API shapes: `rawCard`/`rawPlayer`/`rawBattle`
  factories plus shared constants, so a test overriding one field doesn't restate the rest.
- `src/__mocks__/log.ts` — manual mock auto-applied by a bare `vi.mock("@/log.ts")`. One canonical
  copy of the export surface: a new export from `log.ts` means one edit here, not one per test file.
- `src/deck-image.test.ts` — the default tile fixture is **fully opaque**, so most tests exercise
  `trimToArt`/`cropRaw` with the crop equal to the whole frame. `describe("trimToArt")` covers a
  real crop via `insetFixture`. What stays uncovered is real card art, so verify crop changes
  against it (`deno task preview`, or diff `cropRaw` against `sharp().extract()` across `images/`).

**A throwaway probe script that imports project deps must live inside the repo root.** Deno resolves
`node_modules` from there, so `deno run -A /tmp/probe.ts` fails with `Import "sharp" not a
dependency`. Use `scripts/` (its `*.png` output is gitignored) and delete the probe afterward.

## Code style

- **Tabs** for indentation, trailing commas in ES5 positions (both enforced by oxfmt).
- **Imports** sorted ascending, case-insensitive, grouped with blank lines: side effects → builtins
  → external → internal (`@/`) → relative.
- **No ambient globals for runtime values** — import them (`import { Buffer } from "node:buffer"`,
  in the builtins group), even where Deno's node compat resolves the bare global and lint stays
  green. Genuine platform globals (`fetch`, `Response`, `Deno.*`, `Temporal`, `performance`) are
  fine.
- **Exports gathered at the bottom** of each module: plain declarations in the body, then one sorted
  `export { … }` plus a separate `export type { … }`. No inline `export` on declarations.
- oxlint runs the `typescript`, `unicorn`, and `oxc` plugins with type-aware checking;
  `correctness` defaults to `warn` with specific rules (the `no-unsafe-*`/promise family) raised to
  `error`.
