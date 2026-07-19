# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**stalk** is a **Deno** application (deployed on **Deno Deploy**) built with **Hono**: `Deno.cron` polls one or more Clash Royale players' battle logs every minute via the RoyaleAPI proxy and posts each new 1v1 result to that player's Discord webhook, with a composited deck-grid image per side.

## Commands

```sh
deno task dev     # Local dev server (deno watch -A --tunnel; q + Enter quits)
deno task deploy  # Deploy to Deno Deploy (deployctl; org/app pinned under deno.json "deploy")
```

```sh
deno task test     # Run the Vitest suite
deno task preview  # Render a hardcoded deck to scripts/preview.png (manual; offline, reads images/)
deno task measure  # Report card icons' transparent margins (no args = every icon + aggregate row)
```

```sh
deno task fmt         # Format (oxfmt)
deno task lint        # oxlint && deno lint && deno check --unstable-tsgo .
deno task sync-types  # Regenerate deno.d.ts (run when the Deno version changes)
```

`deno task lint` is the single command that covers everything — do **not** run a separate `tsc --noEmit` or a standalone `deno check`. It chains three passes: oxlint (type-aware via oxlint-tsgolint, resolving `Deno.*` through the vendored `deno.d.ts`), `deno lint` (Deno-idiom rules, no type info), and `deno check --unstable-tsgo` (Deno's own types — real `deno.ns`/unstable surface — via the native TypeScript-Go checker).

### Two type-checkers, two configs

The project deliberately keeps **two** TypeScript configs because oxlint and Deno need different libs:

- `tsconfig.json` — read by oxlint/tsgolint (vanilla TypeScript). Uses `lib: ["ESNext", "DOM"]` for web globals (`fetch`, `console`, `Response`) and picks up `deno.d.ts` for the `Deno.*` surface.
- `deno.json` `compilerOptions` — read by `deno check`/`deno run`. Uses `lib: ["deno.window", "deno.unstable"]` so the real `Deno` namespace (incl. unstable `Deno.cron`/`Deno.openKv`) resolves. Without this, Deno falls back to reading `tsconfig.json`, whose DOM-only lib drops `deno.ns`.

`deno.d.ts` is a **vendored copy of Deno's own `lib.deno.d.ts`** (the full ambient `Deno` surface), so oxlint's type-aware pass can resolve `Deno.*`; re-sync it with `deno task sync-types` (which regenerates via `deno types` and re-formats with oxfmt) when the Deno version changes. It is excluded from `deno check`/`deno lint` (via `deno.json`) and from oxlint's own file walk (`oxlint.config.ts` `ignorePatterns`) so it is only ever consumed as ambient types, never linted or double-declared.

### Dependencies (package.json + node_modules)

Most runtime deps (`@hono/hono`, `@valibot/valibot`, `@std/fmt`) come from **JSR**, but are declared directly in `package.json`'s `dependencies` as `npm:@jsr/<scope>__<name>` aliases (e.g. `"@hono/hono": "npm:@jsr/hono__hono@^4.12.30"`), not as `jsr:` specifiers in `deno.json`'s `imports` map — that map only holds the internal `@/` path alias. Deno resolves the `@jsr` scope natively (no `.npmrc` needed), and `deno.json`'s `preferPackageJson` makes `package.json` the dependency source of truth; `deno.lock` pins the resolved `npm.jsr.io` tarballs. The one exception is `sharp` (`"sharp": "^0.35.3"`), a plain npm dependency rather than a JSR alias — it ships a native libvips addon via platform-filtered `optionalDependencies`, so only the current platform's `@img/sharp-*` binaries are materialized into `node_modules` (Deno Deploy resolves the linux ones from `deno.lock` at deploy time). `@types/node` joins `devDependencies` alongside it, needed by the oxlint/tsgolint vanilla-TypeScript pass to resolve sharp's `Buffer`/`NodeJS.*` type references (`deno check` doesn't need it). sharp's ESM entry exports only `default` at runtime — its `.d.mts` also declares named exports (`cache`, `format`, …) that don't exist in `dist/index.mjs`, so always go through the default (`sharp.cache(false)`), never `import { cache } from "sharp"`.

Putting the JSR deps in `package.json` instead of `deno.json` makes `package.json` the single source of truth: Deno resolves bare specifiers from `node_modules` (`nodeModulesDir: "auto"`) the same way it resolves any node-compat dependency, and so does oxlint/tsgolint (vanilla TypeScript, which only understands `node_modules`, not Deno's import map) — no separate JSR-to-node_modules materialization step to keep in sync. Run `deno install` after cloning to populate `node_modules`.

`src/deck-image.ts` loads `sharp` via a lazy, memoized `import("sharp")`, so the native libvips addon is only dlopen'd on the first deck render instead of every isolate cold boot — the cron ticks every minute but decks render only when a battle happened, so most isolate lifetimes never pay that CPU/memory cost. The memoized loader also runs `sharp.cache(false)` once, since the app's own deck LRU is the only cache wanted; libvips' operation cache would just hold memory. `@std/fmt` formats logs: `@std/fmt/bytes` and `@std/fmt/duration` build the deck-render log line, and `@std/fmt/colors` paints the leveled console badges and inline value highlights, imported only by `src/log.ts`.

`package.json`'s `devDependencies` carries dev tooling (`oxlint`, `oxfmt`, `oxlint-tsgolint`, `vitest`, `@types/node`), installed into the same `node_modules`.

The `@/` alias is declared in **three places that must stay in sync**: `deno.json` `imports` (Deno runtime), `tsconfig.json` `paths` (oxlint/tsgolint), and vitest via `resolve: { tsconfigPaths: true }` in `vitest.config.ts` (which reads the tsconfig `paths`).

## Architecture

### Source files

- `src/main.ts` — Hono app entry point, wiring only; the module runs as a script (`deno run`, not `deno serve` — hence no default export): top-level `Deno.serve` binds the HTTP handler and `Deno.cron` drives polling via `poll()` from `src/poll.ts`. Routes: `GET /` (health check) and `GET /kv/last-battle` (read-only dump of the KV cursors via `poll.ts`'s `listCursors()` — no secrets live in KV). Each cron tick logs a one-line tally of per-target outcomes (`POLL_OUTCOMES`), colored via `levelColor` so the tally matches the badges by construction. When stdin is a terminal it also reads a Vite-style quit key — `q` + Enter runs `server.shutdown()` then `Deno.kill(Deno.pid, "SIGINT")`, since a bare `Deno.exit()` under a watcher (`deno watch`, i.e. `deno run --watch-hmr`) only ends the module run and leaves the watcher supervising an empty process. The `isTerminal()` gate keeps Deploy (no TTY) from consuming a stdin that never yields. The `if (interactive) await quitOnKeypress()` block must stay the file's last statement: its top-level await blocks module evaluation until stdin closes, so anything below it would never run locally (and Deploy, which skips the gate, would mask the breakage). Internal imports use the `@/` import map with explicit `.ts` extensions.
- `src/poll.ts` — The polling domain: owns the Deno KV handle (one `Deno.openKv()` for the isolate's lifetime, kept private — main.ts's read-only cursor route goes through the exported `listCursors()`, which returns raw cursor values keyed by tag) and the `["lastBattle", tag]` cursor key/30-day TTL. `poll(target, token)` fetches the target's battle log, compares the latest eligible battle against the stored cursor (a corrupt cursor logs a warning and re-seeds like a first run), posts to the target's webhook, and advances the cursor only after a successful post (at-least-once delivery); it catches its own errors and resolves one of the exported `POLL_OUTCOMES` (`posted`/`seeded`/`skipped`/`failed`) for the cron tally.
- `src/clashroyale.ts` — Fetches the battle log via the RoyaleAPI proxy (Deploy has no static egress IP to whitelist on the CR token, so the proxy's fixed IP is whitelisted instead), with an abort timeout so a hung request can't stall the cron tick. `latestBattle` picks the newest entry by a cheap timestamp comparison (`EligibleBattleTimeSchema` — malformed and 2v2 entries fall back to `""` and never win) and fully validates only that one entry, so full validation runs once per log instead of once per entry.
- `src/discord.ts` — Builds and posts the Discord message for a single battle: the result, crown score, and HP margin go in the message content (which doubles as the push-notification text), then two embeds (one per side), each titled with that player's name and carrying a composited 2×4 deck-grid image (`attachment://` + multipart upload), trophy rows built from that side's own perspective, and the player's tower troop (curated art when known, else the API icon) as thumbnail; falls back to a text-only embed if rendering fails.
- `src/deck-image.ts` — Composites a deck's 8 card tiles into a bottom-aligned 4-column PNG grid via `sharp` (libvips), loaded through a lazy, memoized `import("sharp")`. Tiles are read from local art in `images/` at the repo root (`import.meta.url`-relative) via `Deno.readFile`, keyed by card `id` and picking the `-evo`/`-hero` variant file per `evolutionLevel`. `images/` holds 177 PNGs (285×420) — `<id>.png` base plus 41 `<id>-evo.png` and 14 `<id>-hero.png` — covering all 122 playable cards; it is a **deploy-required asset** (the renderer hard-depends on it in production and it is uploaded with the deployment). CDN fetch is only a **fallback** for a card id with no local file (e.g. a brand-new card): a warn log names the missing id, then that card's `iconUrls` variant is fetched with a timeout; if that also fails the whole render throws and `discord.ts` posts the text-only fallback message. Each tile is decoded once to raw RGBA (`.ensureAlpha().raw().toUint8Array()` — sharp 0.35's transferable-ArrayBuffer output, the Deno-safe choice over `toBuffer`), the alpha-bounds scan finds the art's bounds, and one `.extract()` pass trims the transparent top/side margins while keeping the native bottom edge as a shared baseline (this one pass uses `toBuffer()` deliberately: `OverlayOptions.input` is typed `Buffer`-only, so the cropped tile feeds `.composite()` castless — `toUint8Array()` is the rule only for data leaving sharp); the grid itself is a single `sharp({create}).composite(overlays).png({compressionLevel: 6}).toUint8Array()` call. Tiles composite at native resolution (no resizing, to preserve the source art) into fixed `CELL_WIDTH`×`CELL_HEIGHT` cells (261×405 — the upper bound of every trimmed icon, from `deno task measure`), so the grid's pixel dimensions stay constant across decks. `COLUMN_GAP`/`ROW_GAP` tune spacing (row gap is a small negative overlap into the kept bottom padding; below roughly −20 the hexagon/champion frames start to clip). There is no per-tile cache (local reads are covered by the OS page cache); the only cache is a small LRU of finished grids keyed by the deck's ordered mirror filenames (`DECK_CACHE_LIMIT` derived from the target count — players repeat decks, so most battles skip the render entirely). The decode-to-raw helper, the alpha-bounds scan used for trimming, and `IMAGES_DIR` are exported for reuse by `scripts/measure.ts`.
- `src/schema.ts` — Valibot schemas for `Battle`, `Player`, `Target` (`TARGETS`), and the `CR_API_TOKEN` env value; normalises the compact ISO 8601 timestamps the CR API sends and captures per-card `id` (the local-art lookup key) and `iconUrls` (tower-troop thumbnail plus CDN-fallback source). Also exports `EligibleBattleTimeSchema` (the cheap newest-battle eligibility check) and `CursorSchema` (validates a stored KV cursor instead of trusting a raw `kv.get` cast).
- `src/env.ts` — Reads and validates all env vars once at module load (`parseEnv` logs invalid values and falls back); exports `config` (`{ token, targets }`, or `undefined` when the token is missing).
- `src/log.ts` — Thin `console` wrapper (`log.info`/`success`/`warn`/`error`/`debug`) that prefixes each line with a bold, fixed-width, colored level badge; every other module logs through it so local dev and Deno Deploy output read as one leveled stream. The **only** module that imports `@std/fmt/colors` (so every paint call runs after the color gate below), it also exports `levelColor` — the badge palette, reused by main.ts's cron tally so outcome colors match the badges by construction — and `hl`, semantic highlighters for dynamic values inside messages: `entity` (the identifier a line is about, e.g. player tag or env var name), `value` (a standout measurement or address), `strong` (bold; safe inside any tinted message, including `debug`'s greyed text). The concrete colors live only in `hl`'s definition. Color is enabled only when stdout is a terminal and `NO_COLOR` is unset (`setColorEnabled` at module load), so piped/captured output stays plain text.

### Flow

1. `Deno.cron` fires every minute → `config` from `src/env.ts` supplies the token and targets (read and validated once at module load; `undefined` when the token is missing, which skips the tick with a heartbeat log), then `poll(target)` runs for each player concurrently (`Promise.all` — `poll` catches its own errors, so it never rejects)
2. Fetch battle log for the target's `tag` via `https://proxy.royaleapi.dev/v1`
3. Compare the latest eligible battle's `battleTime` against the cursor stored in Deno KV under the tuple key `["lastBattle", tag]` (written with a 30-day `expireIn` TTL, so cursors for players removed from `TARGETS` self-clean; each posted/seeded battle resets the clock, and a cursor that does expire just re-seeds silently like a first run) — cursors are namespaced per tag, so all players share one KV without colliding. 2v2 battles are ignored at selection time (`latestBattle`), so they never post and never advance the cursor past an unposted 1v1. A stored cursor that fails `CursorSchema` (corrupt) logs a warning and re-seeds like a first run, instead of re-posting every tick against a cursor that can never match
4. On first run: seed the cursor without posting (avoids a stale notification)
5. On subsequent runs with a new battle: post the embed to the target's webhook, then update the cursor. The cursor advances only **after** a successful post — at-least-once delivery: if the webhook succeeds but the KV put throws, the next tick re-posts a duplicate rather than dropping a battle

### KV & secrets

| Name           | Kind     | Purpose                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| Deno KV        | KV store | Stores the `["lastBattle", tag]` cursor (opened via `Deno.openKv`), 30-day TTL |
| `CR_API_TOKEN` | Env var  | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP             |
| `TARGETS`      | Env var  | JSON array of `{ tag, webhook }` pairs, one per tracked player                 |

`TARGETS` is parsed and validated by `TargetsEnvSchema` (src/schema.ts), which takes the raw env string through `v.parseJson()` — malformed or unset values surface as validation issues, not thrown `SyntaxError`s. Player tags are normalized at parse time to canonical `#UPPERCASE` form (`TagSchema`), which the KV cursor keys and player lookup rely on. Env vars are read via `Deno.env.get`. Locally they live in `.env` (gitignored; see `.env.example`) — **wrap `TARGETS` in single quotes** there, since the `#` in a player tag otherwise starts a comment and truncates the value; in production they're set in the Deno Deploy dashboard (or `deployctl`). Deno KV and `Deno.cron` require the `kv`/`cron` unstable flags, declared in `deno.json`.

## Testing

`deno task test` runs `vitest` (from `node_modules/.bin`, via `deno task`'s shell), which stays inside the Deno process — so `Deno.*` (KV, cron, env) is still the real ambient global, and tests spy on it directly (e.g. `src/main.test.ts` spies `Deno.openKv`/`Deno.cron`/`Deno.serve` rather than mocking a wrapper — the `Deno.serve` spy captures the fetch handler the tests drive routes through, and keeps each import from binding a real port; `src/poll.test.ts` needs only the `Deno.openKv` spy, calling `poll()` directly and asserting its returned outcome, with cursor state read back through `listCursors()`). `vitest.config.ts`'s `environment: "node"` only selects vitest's non-DOM global set; it's unrelated to the underlying runtime. Test discovery is scoped to `dir: "./src"` (skips walking `images/`'s 177 PNGs and `scripts/`). Its `restoreMocks`/`unstubGlobals`/`unstubEnvs`/`clearMocks` are all on globally (no test uses `.concurrent` — several mutate real shared `globalThis` state: `Deno.openKv`/`Deno.cron` spies, stubbed `fetch`, stubbed env — which concurrent tests in a file would race on regardless).

- `src/__mocks__/log.ts` — manual mock for `@/log.ts`, auto-applied by a bare `vi.mock("@/log.ts")` (no factory). One canonical copy of the module's export surface, so a new export means one edit here instead of one per test file; `hl`/`levelColor` are identity functions, matching the real module's behavior with color disabled.
- `src/testing/kv.ts` — `spyMemoryKv()`, the shared `Deno.openKv` spy: redirects the module-under-test's top-level `await Deno.openKv()` to a fresh isolated `:memory:` store and returns a getter for the captured handle; registers an `afterEach` on import that closes the store between tests. Used by both `importMain` and `importPoll`.
- `src/testing/fixtures.ts` — shared raw (pre-validation) Clash Royale API shapes: `rawCard`/`rawPlayer`/`rawBattle` factories tests build on by spreading in overrides, plus shared constants (`WEBHOOK`, `BOB`, `rawBattle`'s default opponent) so tests overriding one field don't restate the rest.
- `scripts/preview.ts` — dev-only tool that renders a hardcoded deck (by real card ids) via `renderDeckGrid` and writes it next to itself for visual inspection. Offline — it reads local art from `images/`, no network. Not wired into `deno task test` because it writes a file (`scripts/*.png` is gitignored); run manually via `deno task preview`.
- `scripts/measure.ts` — dev-only tool that reports the transparent margins baked into card icons, reading the renderer's own `IMAGES_DIR` (offline). `deno task measure 26000032 26000032-evo` measures specific icons; no args measures every icon and prints the aggregate row that `CELL_WIDTH`/`CELL_HEIGHT` and `ROW_GAP`'s floor are tuned against.

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- **Exports** are gathered at the bottom of each module — plain (non-exported) declarations in the body, then one sorted `export { … }` list plus a separate `export type { … }` line; no inline `export` on declarations
- oxlint runs with `typescript`, `unicorn`, and `oxc` plugins, type-aware checking enabled; the `correctness` category defaults to `warn` with specific rules (e.g. the `no-unsafe-*`/promise rules) individually raised to `error`
