# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
pnpm dev          # Start local dev server via Wrangler
pnpm deploy       # Deploy to Cloudflare Workers (minified)
pnpm cf-typegen   # Regenerate CloudflareBindings types from wrangler.jsonc
```

```sh
pnpm run fmt      # Format (oxfmt)
pnpm run lint     # Lint (oxlint)
```

## Architecture

This is a **Cloudflare Workers** application built with **Hono** that polls a Clash Royale player's battle log and posts results to a Discord channel via webhook.

### Source files

- `src/index.ts` — Hono app entry point; exports the `fetch` handler and the `scheduled` cron handler that drives polling
- `src/clashroyale.ts` — Fetches and parses the battle log via the RoyaleAPI proxy; skips entries that fail schema validation
- `src/discord.ts` — Builds and posts a Discord embed for a single battle (win/loss/draw colours, deck fields, tower troop support cards)
- `src/schema.ts` — Valibot schemas for `Battle` and `Player`; normalises the compact ISO 8601 timestamps the CR API sends

### Flow

1. Cron fires every minute → parse `TARGETS`, then `poll(env, target)` for each player concurrently (`Promise.allSettled`)
2. Fetch battle log for the target's `tag` via `https://proxy.royaleapi.dev/v1`
3. Compare the latest `battleTime` against the cursor stored in `STALK_KV` (`lastBattle:<tag>`) — cursors are namespaced per tag, so all players share one KV
4. On first run: seed the cursor without posting (avoids a stale notification)
5. On subsequent runs with a new battle: post the embed to the target's webhook, then update the cursor

### Bindings & secrets

| Name           | Kind         | Purpose                                                            |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `STALK_KV`     | KV namespace | Stores the `lastBattle:<tag>` cursor                               |
| `CR_API_TOKEN` | Secret       | Bearer token for the CR API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Secret       | JSON array of `{ tag, webhook }` pairs, one per tracked player     |

`TARGETS` is parsed and validated by `TargetsSchema` (src/schema.ts). Secrets are set via `wrangler secret put` and must never appear in `wrangler.jsonc`.

When Cloudflare bindings change in `wrangler.jsonc`, run `pnpm cf-typegen` to regenerate `worker-configuration.d.ts`.

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with `typescript`, `unicorn`, and `oxc` plugins at `correctness: error`, with type-aware checking enabled
