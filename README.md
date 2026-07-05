# stalk

A **Deno** application (deployed on **Deno Deploy**), built with **Hono**, that polls one or more Clash Royale players' battle logs every minute and posts new results to Discord via webhook. Each tracked player is paired with its own webhook.

## How it works

1. `Deno.cron` fires every minute → `config` (from `src/env.ts`, read and validated once at module load) supplies the token and targets; a missing token skips the tick with a heartbeat log. Otherwise `poll(target)` runs for each player concurrently (`Promise.all` — `poll` catches its own errors and never rejects, so one player's failure can't sink the others).
2. The player's battle log is fetched for their `tag` via the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) (`https://proxy.royaleapi.dev/v1`), which gives a stable outbound IP to whitelist on the API token.
3. The latest `battleTime` is compared against a cursor stored in Deno KV under the tuple key `["lastBattle", tag]`. Cursors are namespaced per tag, so every player shares one KV store without colliding.
4. **First run:** the cursor is seeded without posting, to avoid a stale notification.
5. **Subsequent runs with a new battle:** a Discord message is posted to that player's webhook — the result and crown score in the message content, then one embed per player, each titled with that player's name and showing that side's deck as a composited card-image grid — then the cursor is updated.

Battle log entries that fail schema validation are skipped. To stay cheap, the newest entry is picked by a fast timestamp comparison and only that one entry is fully validated against the schema — so full validation runs once per log instead of once per entry.

## Source files

| File                 | Responsibility                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`        | Hono app entry point; `export default app` (the `fetch` handler — `GET /` health check, `GET /kv/last-battle` cursor view) and the `Deno.cron` handler                                                                                 |
| `src/clashroyale.ts` | Fetches and parses the battle log via the RoyaleAPI proxy; selects and validates the latest battle                                                                                                                                     |
| `src/discord.ts`     | Builds and posts the battle message: result and crown score in the content; two embeds (one per player), each titled with the player's name, with a deck-grid image and tower-troop thumbnail; text-only fallback if rendering fails   |
| `src/deck-image.ts`  | Composites a deck's 8 card icons into a bottom-aligned 4-column PNG grid via ImageScript; trims transparent margins, renders at native resolution, and caches both trimmed tiles (by icon URL) and finished grids (by deck, small LRU) |
| `src/schema.ts`      | Valibot schemas for `Battle`, `Player`, and `TARGETS`; normalises the compact ISO 8601 timestamps the CR API sends and captures per-card `iconUrls`                                                                                    |
| `src/env.ts`         | Reads and validates all env vars once at module load; exports `config` (`{ token, targets }`, or `undefined` when the token is missing)                                                                                                |

## Dependencies

Runtime dependencies come from [JSR](https://jsr.io) — `@hono/hono`, `@valibot/valibot`, `@matmen/imagescript` (deck-image compositing), and `@std/fmt` (log formatting) — declared directly in `package.json`'s `dependencies` as `npm:@jsr/<scope>__<name>` aliases; Deno resolves the `@jsr` scope natively, and `preferPackageJson` in `deno.json` makes `package.json` the dependency source of truth (no `.npmrc` needed). This lets both Deno and oxlint's type-aware pass resolve them straight out of `node_modules`, with no separate materialization step. `package.json`'s `devDependencies` carries dev tooling (oxlint, oxfmt). Run `deno install` after cloning.

## Setup

### Prerequisites

- [Deno](https://deno.com/) 2.x
- A [Clash Royale API](https://developer.clashroyale.com/) token, whitelisted to the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) IP
- A Discord channel [webhook URL](https://support.discord.com/hc/en-us/articles/228383668)

### 1. Configure secrets

Copy `.env.example` to `.env` (gitignored) and fill in the values:

```sh
cp .env.example .env
```

```sh
CR_API_TOKEN=...
TARGETS='[{ "tag": "#A9AA008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" }]'
```

`TARGETS` is a JSON array pairing each player tag (keep the leading `#`) with the Discord webhook to notify. **Wrap the value in single quotes** — the leading `#` in a tag would otherwise start a comment and truncate the value in the env file. It is validated by `TargetsEnvSchema` (`src/schema.ts`). Add as many entries as you want to track:

```json
[
	{ "tag": "#A9AA008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" },
	{ "tag": "#P7BB114L", "webhook": "https://discord.com/api/webhooks/ccc/ddd" }
]
```

A malformed `TARGETS` value fails soft: it logs once and polls nobody, rather than throwing on every cron tick.

### 2. Run locally

```sh
deno task dev
```

This starts `deno serve --watch` and loads `.env`. Deno KV is backed by a local SQLite store in dev. `Deno.cron` is registered at startup; on the local scheduler it fires on the minute (vs. Deno Deploy's managed scheduler in production).

### 3. Deploy

Set `CR_API_TOKEN` and `TARGETS` as environment variables in the Deno Deploy project (dashboard or `deployctl`), then:

```sh
deno task deploy
```

Deno KV and `Deno.cron` are provisioned automatically on Deno Deploy — no separate namespace creation step.

## KV & secrets

| Name           | Kind     | Purpose                                                            |
| -------------- | -------- | ------------------------------------------------------------------ |
| Deno KV        | KV store | Stores the `["lastBattle", tag]` cursor (opened via `Deno.openKv`) |
| `CR_API_TOKEN` | Env var  | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Env var  | JSON array of `{ tag, webhook }` pairs, one per tracked player     |

Env vars are read and validated once at module load in `src/env.ts` — locally from `.env`, in production from the Deno Deploy project settings.

## Commands

```sh
deno task dev     # Start local dev server (deno serve --watch, loads .env)
deno task deploy  # Deploy to Deno Deploy (via deployctl)
```

```sh
deno task fmt     # Format (oxfmt)
deno task lint    # oxlint && deno lint && deno check --unstable-tsgo src/main.ts
```

`deno task lint` covers everything — do **not** run a separate `tsc --noEmit` or a standalone `deno check`. It chains oxlint (type-aware via oxlint-tsgolint), `deno lint` (Deno-idiom rules), and `deno check --unstable-tsgo` (Deno's own types via the native TypeScript-Go checker).

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with the `typescript`, `unicorn`, and `oxc` plugins, type-aware checking enabled; the `correctness` category defaults to `warn` with specific rules individually raised to `error`
