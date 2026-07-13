# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
deno task dev     # Start local dev server (deno watch --tunnel; q + Enter quits)
deno task deploy  # Deploy to Deno Deploy (via deployctl)
```

```sh
deno task test     # Run the Vitest suite
deno task preview  # Render a hardcoded deck to scripts/preview.png (manual; hits the real CR CDN)
```

```sh
deno task fmt     # Format (oxfmt)
deno task lint    # oxlint && deno lint && deno check --unstable-tsgo .
```

`deno task lint` is the single command that covers everything — do **not** run a separate `tsc --noEmit` or a standalone `deno check`. It chains three passes: oxlint (type-aware via oxlint-tsgolint, resolving `Deno.*` through the vendored `deno.d.ts`), `deno lint` (Deno-idiom rules, no type info), and `deno check --unstable-tsgo` (Deno's own types — real `deno.ns`/unstable surface — via the native TypeScript-Go checker).

### Two type-checkers, two configs

The project deliberately keeps **two** TypeScript configs because oxlint and Deno need different libs:

- `tsconfig.json` — read by oxlint/tsgolint (vanilla TypeScript). Uses `lib: ["ESNext", "DOM"]` for web globals (`fetch`, `console`, `Response`) and picks up `deno.d.ts` for the `Deno.*` surface.
- `deno.json` `compilerOptions` — read by `deno check`/`deno run`. Uses `lib: ["deno.window", "deno.unstable"]` so the real `Deno` namespace (incl. unstable `Deno.cron`/`Deno.openKv`) resolves. Without this, Deno falls back to reading `tsconfig.json`, whose DOM-only lib drops `deno.ns`.

`deno.d.ts` is a **vendored copy of Deno's own `lib.deno.d.ts`** (the full ambient `Deno` surface), so oxlint's type-aware pass can resolve `Deno.*`; re-sync it with `deno task sync-types` (which regenerates via `deno types` and re-formats with oxfmt) when the Deno version changes. It is excluded from `deno check`/`deno lint` (via `deno.json`) and from oxlint's own file walk (`oxlint.config.ts` `ignorePatterns`) so it is only ever consumed as ambient types, never linted or double-declared.

### Dependencies (package.json + node_modules)

Runtime deps (`@hono/hono`, `@valibot/valibot`, `@matmen/imagescript`, `@std/fmt`) come from **JSR**, but are declared directly in `package.json`'s `dependencies` as `npm:@jsr/<scope>__<name>` aliases (e.g. `"@hono/hono": "npm:@jsr/hono__hono@^4.12.27"`), not as `jsr:` specifiers in `deno.json`'s `imports` map — that map only holds the internal `@/` path alias. Deno resolves the `@jsr` scope natively (no `.npmrc` needed), and `deno.json`'s `preferPackageJson` makes `package.json` the dependency source of truth; `deno.lock` pins the resolved `npm.jsr.io` tarballs.

Putting the JSR deps in `package.json` instead of `deno.json` makes `package.json` the single source of truth: Deno resolves bare specifiers from `node_modules` (`nodeModulesDir: "auto"`) the same way it resolves any node-compat dependency, and so does oxlint/tsgolint (vanilla TypeScript, which only understands `node_modules`, not Deno's import map) — no separate JSR-to-node_modules materialization step to keep in sync. Run `deno install` after cloning to populate `node_modules`.

`@matmen/imagescript` is pulled in via a dynamic `import()` in `src/deck-image.ts`, so its ~1.8 MB of codec WASM is compiled only on the first deck render instead of every isolate cold boot. `@std/fmt` formats logs: `@std/fmt/bytes` and `@std/fmt/duration` build the deck-render log line, and `@std/fmt/colors` paints the leveled console badges and inline value highlights, imported only by `src/log.ts`.

`package.json`'s `devDependencies` carries dev tooling (`oxlint`, `oxfmt`, `oxlint-tsgolint`, `vitest`), installed into the same `node_modules`.

The `@/` alias is declared in **three places that must stay in sync**: `deno.json` `imports` (Deno runtime), `tsconfig.json` `paths` (oxlint/tsgolint), and vitest via `resolve: { tsconfigPaths: true }` in `vitest.config.ts` (which reads the tsconfig `paths`).

## Architecture

This is a **Deno** application (deployed on **Deno Deploy**) built with **Hono** that polls a Clash Royale player's battle log and posts results to a Discord channel via webhook.

### Source files

- `src/main.ts` — Hono app entry point; the module runs as a script (`deno run`, not `deno serve` — hence no default export): top-level `Deno.serve` binds the HTTP handler and `Deno.cron` drives polling. When stdin is a terminal it also reads a Vite-style quit key — `q` + Enter runs `server.shutdown()` then `Deno.kill(Deno.pid, "SIGINT")`, since a bare `Deno.exit()` under a watcher (`deno watch`, i.e. `deno run --watch-hmr`) only ends the module run and leaves the watcher supervising an empty process. The `isTerminal()` gate keeps Deploy (no TTY) from consuming a stdin that never yields. Internal imports use the `@/` import map with explicit `.ts` extensions.
- `src/clashroyale.ts` — Fetches and parses the battle log via the RoyaleAPI proxy; selects the newest eligible battle (2v2s and entries that fail schema validation are ignored)
- `src/discord.ts` — Builds and posts the Discord message for a single battle: the result, crown score, and HP margin go in the message content (which doubles as the push-notification text), then two embeds (one per side), each titled with that player's name and carrying a composited 2×4 deck-grid image (`attachment://` + multipart upload), trophy rows built from that side's own perspective, and the player's tower troop (curated art when known, else the API icon) as thumbnail; falls back to a text-only embed if rendering fails
- `src/deck-image.ts` — Composites a deck's 8 card icons (CR CDN; picks the Evo/Hero art variant per `evolutionLevel`) into a bottom-aligned 4-column PNG grid via ImageScript (dynamically imported). Trims each icon's transparent margin but keeps its native bottom edge as a shared baseline and composites at native resolution (ImageScript only resizes nearest-neighbour, which blurs). Two promise caches: trimmed tiles keyed by icon URL (stored as re-encoded PNG bytes to bound memory; inflated per render) and finished grids keyed by the deck's ordered icon URLs (small LRU, `DECK_CACHE_LIMIT` derived from the target count — players repeat decks, so most battles skip the render entirely); `COLUMN_GAP`/`ROW_GAP` tune spacing (row gap is a small negative overlap into the kept bottom padding).
- `src/schema.ts` — Valibot schemas for `Battle`, `Player`, `Target` (`TARGETS`), and the `CR_API_TOKEN` env value; normalises the compact ISO 8601 timestamps the CR API sends and captures per-card `iconUrls`
- `src/env.ts` — Reads and validates all env vars once at module load (`parseEnv` logs invalid values and falls back); exports `config` (`{ token, targets }`, or `undefined` when the token is missing)
- `src/log.ts` — Thin `console` wrapper (`log.info`/`success`/`warn`/`error`/`debug`) that prefixes each line with a bold, fixed-width, colored level badge; every other module logs through it so local dev and Deno Deploy output read as one leveled stream. The **only** module that imports `@std/fmt/colors` (so every paint call runs after the color gate below), it also exports `levelColor` — the badge palette, reused by main.ts's cron tally so outcome colors match the badges by construction — and `hl`, semantic highlighters for dynamic values inside messages: `entity` (the identifier a line is about, e.g. player tag or env var name), `value` (a standout measurement or address), `strong` (bold; safe inside any tinted message, including `debug`'s greyed text). The concrete colors live only in `hl`'s definition. Color is enabled only when stdout is a terminal and `NO_COLOR` is unset (`setColorEnabled` at module load), so piped/captured output stays plain text

### Flow

1. `Deno.cron` fires every minute → `config` from `src/env.ts` supplies the token and targets (read and validated once at module load; `undefined` when the token is missing, which skips the tick with a heartbeat log), then `poll(target)` runs for each player concurrently (`Promise.all` — `poll` catches its own errors, so it never rejects)
2. Fetch battle log for the target's `tag` via `https://proxy.royaleapi.dev/v1`
3. Compare the latest eligible battle's `battleTime` against the cursor stored in Deno KV under the tuple key `["lastBattle", tag]` — cursors are namespaced per tag, so all players share one KV without colliding. 2v2 battles are ignored at selection time (`latestBattle`), so they never post and never advance the cursor past an unposted 1v1
4. On first run: seed the cursor without posting (avoids a stale notification)
5. On subsequent runs with a new battle: post the embed to the target's webhook, then update the cursor

### KV & secrets

| Name           | Kind     | Purpose                                                            |
| -------------- | -------- | ------------------------------------------------------------------ |
| Deno KV        | KV store | Stores the `["lastBattle", tag]` cursor (opened via `Deno.openKv`) |
| `CR_API_TOKEN` | Env var  | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Env var  | JSON array of `{ tag, webhook }` pairs, one per tracked player     |

`TARGETS` is parsed and validated by `TargetsEnvSchema` (src/schema.ts), which takes the raw env string through `v.parseJson()` — malformed or unset values surface as validation issues, not thrown `SyntaxError`s. Player tags are normalized at parse time to canonical `#UPPERCASE` form (`TagSchema`), which the KV cursor keys and player lookup rely on. Env vars are read via `Deno.env.get`. Locally they live in `.env` (gitignored; see `.env.example`); in production they're set in the Deno Deploy dashboard (or `deployctl`). Deno KV and `Deno.cron` require the `kv`/`cron` unstable flags, declared in `deno.json`.

## Testing

`deno task test` runs `vitest` (from `node_modules/.bin`, via `deno task`'s shell), which stays inside the Deno process — so `Deno.*` (KV, cron, env) is still the real ambient global, and tests spy on it directly (e.g. `src/main.test.ts` spies `Deno.openKv`/`Deno.cron`/`Deno.serve` rather than mocking a wrapper — the `Deno.serve` spy captures the fetch handler the tests drive routes through, and keeps each import from binding a real port). `vitest.config.ts`'s `environment: "node"` only selects vitest's non-DOM global set; it's unrelated to the underlying runtime. Its `restoreMocks`/`unstubGlobals`/`unstubEnvs`/`clearMocks` are all on globally (no test uses `.concurrent` — several mutate real shared `globalThis` state: `Deno.openKv`/`Deno.cron` spies, stubbed `fetch`, stubbed env — which concurrent tests in a file would race on regardless).

- `src/__mocks__/log.ts` — manual mock for `@/log.ts`, auto-applied by a bare `vi.mock("@/log.ts")` (no factory). One canonical copy of the module's export surface, so a new export means one edit here instead of one per test file; `hl`/`levelColor` are identity functions, matching the real module's behavior with color disabled.
- `src/testing/fixtures.ts` — shared raw (pre-validation) Clash Royale API shapes: `rawCard`/`rawPlayer`/`rawBattle` factories tests build on by spreading in overrides, plus shared constants (`WEBHOOK`, `BOB`, `rawBattle`'s default opponent) so tests overriding one field don't restate the rest.
- `scripts/preview.ts` — dev-only tool that renders a hardcoded deck via `renderDeckGrid` and writes it next to itself for visual inspection. Not wired into `deno task test`: it fetches real card icons from the CR CDN (not hermetic) and writes a file (`scripts/*.png` is gitignored); run manually via `deno task preview`.

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with `typescript`, `unicorn`, and `oxc` plugins, type-aware checking enabled; the `correctness` category defaults to `warn` with specific rules (e.g. the `no-unsafe-*`/promise rules) individually raised to `error`
