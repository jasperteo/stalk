# stalk

A **Cloudflare Workers** application, built with **Hono**, that polls one or more Clash Royale players' battle logs every minute and posts new results to Discord via webhook. Each tracked player is paired with its own webhook.

## How it works

1. A cron fires every minute → `parseTargets(env)` reads the `TARGETS` secret, then `poll(env, target)` runs for each player concurrently (`Promise.allSettled`, so one player's failure can't sink the others).
2. The player's battle log is fetched for their `tag` via the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) (`https://proxy.royaleapi.dev/v1`), which gives the Worker a stable outbound IP to whitelist on the API token.
3. The latest `battleTime` is compared against a cursor stored in `STALK_KV` (`lastBattle:<tag>`). Cursors are namespaced per tag, so every player shares one KV namespace without colliding.
4. **First run:** the cursor is seeded without posting, to avoid a stale notification.
5. **Subsequent runs with a new battle:** a Discord embed is posted to that player's webhook, then the cursor is updated.

Battle log entries that fail schema validation are skipped. To stay cheap, the newest entry is picked by a fast timestamp comparison and only that one entry is fully validated against the schema — so per-target CPU stays flat as the number of tracked players grows.

## Source files

| File                 | Responsibility                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`       | Hono app entry point; exports the `fetch` handler (`GET /` health check) and the `scheduled` cron handler          |
| `src/clashroyale.ts` | Fetches and parses the battle log via the RoyaleAPI proxy; selects and validates the latest battle                 |
| `src/discord.ts`     | Builds and posts a Discord embed for a single battle (win/loss/draw colours, deck fields, tower troops)            |
| `src/schema.ts`      | Valibot schemas for `Battle`, `Player`, and `TARGETS`; normalises the compact ISO 8601 timestamps the CR API sends |

## Setup

### Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — the Cloudflare Workers CLI
- A [Clash Royale API](https://developer.clashroyale.com/) token, whitelisted to the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) IP
- A Discord channel [webhook URL](https://support.discord.com/hc/en-us/articles/228383668)

### 1. Create the KV namespace

```sh
wrangler kv namespace create STALK_KV
```

Copy the returned `id` into the `kv_namespaces` entry in `wrangler.jsonc`.

### 2. Set secrets

Secrets are set via `wrangler secret put` and must never appear in `wrangler.jsonc`.

```sh
wrangler secret put CR_API_TOKEN
wrangler secret put TARGETS
```

`TARGETS` is a JSON array pairing each player tag (keep the leading `#`) with the Discord webhook to notify. It is validated by `TargetsSchema` (`src/schema.ts`). Add as many entries as you want to track:

```json
[
	{ "tag": "#G9GY008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" },
	{ "tag": "#ABC123", "webhook": "https://discord.com/api/webhooks/ccc/ddd" }
]
```

A malformed `TARGETS` secret fails soft: it logs once and polls nobody, rather than throwing on every cron tick.

### 3. Deploy

```sh
pnpm deploy
```

## Bindings & secrets

| Name           | Kind         | Purpose                                                            |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `STALK_KV`     | KV namespace | Stores the `lastBattle:<tag>` cursor                               |
| `CR_API_TOKEN` | Secret       | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Secret       | JSON array of `{ tag, webhook }` pairs, one per tracked player     |

When Cloudflare bindings change in `wrangler.jsonc`, run `pnpm cf-typegen` to regenerate `worker-configuration.d.ts`.

## Commands

```sh
pnpm dev          # Start local dev server via Wrangler
pnpm deploy       # Deploy to Cloudflare Workers (minified)
pnpm cf-typegen   # Regenerate CloudflareBindings types from wrangler.jsonc
```

```sh
pnpm run fmt      # Format (oxfmt)
pnpm run lint     # Lint + type-check (oxlint with oxlint-tsgolint, type-aware)
```

`pnpm run lint` is type-aware (oxlint-tsgolint), so it covers type checking — do **not** run a separate `tsc --noEmit`.

`pnpm dev` does not fire cron triggers. Trigger the `scheduled` handler manually during local dev:

```sh
curl "http://localhost:8787/__scheduled?cron=*%2F1+*+*+*+*"
```

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with the `typescript`, `unicorn`, and `oxc` plugins at `correctness: error`, with type-aware checking enabled
