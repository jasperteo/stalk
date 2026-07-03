# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
deno task dev     # Start local dev server (deno serve --watch, loads .env)
deno task deploy  # Deploy to Deno Deploy (via deployctl)
```

```sh
deno task fmt     # Format (oxfmt)
deno task lint    # oxlint && deno lint && deno check --unstable-tsgo src/main.ts
```

`deno task lint` is the single command that covers everything — do **not** run a separate `tsc --noEmit` or a standalone `deno check`. It chains three passes: oxlint (type-aware via oxlint-tsgolint, resolving `Deno.*` through the ambient stub in `deno.d.ts`), `deno lint` (Deno-idiom rules, no type info), and `deno check --unstable-tsgo` (Deno's own types — real `deno.ns`/unstable surface — via the native TypeScript-Go checker).

### Two type-checkers, two configs

The project deliberately keeps **two** TypeScript configs because oxlint and Deno need different libs:

- `tsconfig.json` — read by oxlint/tsgolint (vanilla TypeScript). Uses `lib: ["ESNext", "DOM"]` for web globals (`fetch`, `console`, `Response`) and picks up `deno.d.ts` for the `Deno.*` surface.
- `deno.json` `compilerOptions` — read by `deno check`/`deno serve`. Uses `lib: ["deno.window", "deno.unstable"]` so the real `Deno` namespace (incl. unstable `Deno.cron`/`Deno.openKv`) resolves. Without this, Deno falls back to reading `tsconfig.json`, whose DOM-only lib drops `deno.ns`.

`deno.d.ts` is a **minimal ambient declaration** of only the `Deno` APIs this project uses, so oxlint's type-aware pass can resolve them. It is excluded from `deno check`/`deno lint` (via `deno.json`) so it never clashes with Deno's built-in lib.

### Dependencies (JSR + node_modules)

Runtime deps (`@hono/hono`, `@valibot/valibot`) come from **JSR**, declared in `deno.json`'s `imports` map as `jsr:` specifiers and imported by their **full scoped names** (not bare `hono`/`valibot`).

The non-obvious part is `"jsrDepsInNodeModules": true` in `deno.json`. It materializes those JSR packages into `node_modules` via JSR's npm-compat registry (`@jsr/<scope>__<name>`, symlinked as `@hono/hono` etc.) and makes `deno install` write `.npmrc` (`@jsr:registry=https://npm.jsr.io`). This is what lets oxlint/tsgolint — vanilla TypeScript, which resolves through `node_modules`, not Deno's import map — type-check the deps. **Commit `.npmrc`.** Without this flag, JSR deps live only in Deno's global cache and oxlint reports every hono/valibot member as an `error`-typed value.

`package.json` carries **only** dev tooling (`oxlint`, `oxfmt`, `oxlint-tsgolint`); `deno install` installs it into the same `node_modules`. Run `deno install` after cloning.

## Architecture

This is a **Deno** application (deployed on **Deno Deploy**) built with **Hono** that polls a Clash Royale player's battle log and posts results to a Discord channel via webhook.

### Source files

- `src/main.ts` — Hono app entry point; `export default app` provides the `fetch` handler and `Deno.cron` drives polling. Internal imports use the `@/` import map with explicit `.ts` extensions.
- `src/clashroyale.ts` — Fetches and parses the battle log via the RoyaleAPI proxy; skips entries that fail schema validation
- `src/discord.ts` — Builds and posts a Discord embed for a single battle (win/loss/draw colours, deck fields, tower troop support cards)
- `src/schema.ts` — Valibot schemas for `Battle` and `Player`; normalises the compact ISO 8601 timestamps the CR API sends

### Flow

1. `Deno.cron` fires every minute → `loadConfig()` supplies the token and `TARGETS` (read and validated once per isolate, memoized), then `poll(target)` runs for each player concurrently (`Promise.all` — `poll` catches its own errors, so it never rejects)
2. Fetch battle log for the target's `tag` via `https://proxy.royaleapi.dev/v1`
3. Compare the latest `battleTime` against the cursor stored in Deno KV under the tuple key `["lastBattle", tag]` — cursors are namespaced per tag, so all players share one KV without colliding
4. On first run: seed the cursor without posting (avoids a stale notification)
5. On subsequent runs with a new battle: post the embed to the target's webhook, then update the cursor

### KV & secrets

| Name           | Kind     | Purpose                                                            |
| -------------- | -------- | ------------------------------------------------------------------ |
| Deno KV        | KV store | Stores the `["lastBattle", tag]` cursor (opened via `Deno.openKv`) |
| `CR_API_TOKEN` | Env var  | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Env var  | JSON array of `{ tag, webhook }` pairs, one per tracked player     |

`TARGETS` is parsed and validated by `TargetsEnvSchema` (src/schema.ts), which takes the raw env string through `v.parseJson()` — malformed or unset values surface as validation issues, not thrown `SyntaxError`s. Player tags are normalized at parse time to canonical `#UPPERCASE` form (`TagSchema`), which the KV cursor keys and player lookup rely on. Env vars are read via `Deno.env.get`. Locally they live in `.env` (gitignored; see `.env.example`); in production they're set in the Deno Deploy dashboard (or `deployctl`). Deno KV and `Deno.cron` require the `kv`/`cron` unstable flags, declared in `deno.json`.

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with `typescript`, `unicorn`, and `oxc` plugins, type-aware checking enabled; the `correctness` category defaults to `warn` with specific rules (e.g. the `no-unsafe-*`/promise rules) individually raised to `error`
