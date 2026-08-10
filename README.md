# stalk

Watches Clash Royale players and posts their matches to Discord.

A [Deno](https://deno.com/) app (deployed on [Deno Deploy](https://deno.com/deploy), built with
[Hono](https://hono.dev/)) that polls one or more players' battle logs every minute and posts each
new result to that player's own webhook — the outcome, crown score, and HP margin as the message
text, then an embed per side with trophies, tower troop, and the full deck rendered as a card-image
grid.

## How it works

1. `Deno.cron` fires every minute and polls every tracked player concurrently. One player's failure
   can't sink the others, and each tick ends with a one-line tally
   (`posted` / `seeded` / `skipped` / `drifted` / `failed`).
2. The battle log is fetched via the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy), which
   provides the stable outbound IP that the Clash Royale API token is whitelisted against — Deno
   Deploy has none of its own.
3. The newest eligible battle's timestamp is compared against a cursor in Deno KV, stored per player
   under `["lastBattle", tag]` with a 30-day TTL, so cursors for players you stop tracking clean
   themselves up.
4. **First run:** the cursor is seeded without posting, so you don't get a notification about a
   match from last week.
5. **After that:** a new battle is posted to the webhook, and only then does the cursor advance. If
   the post succeeds but the cursor write fails, the next tick re-posts rather than dropping the
   battle — a rare duplicate beats a silent loss.

2v2 and Duel battles are ignored (a Duel concatenates 2–3 decks into one match, not a single 1v1
loadout), and entries that fail schema validation are skipped. The newest eligible
entry is picked by a fast timestamp comparison and only that one is fully validated, so validation
runs once per log rather than once per entry.

**At most one battle is posted per tick — the newest.** A player who finishes several matches
between ticks has the intermediate ones skipped; the cursor jumps straight to the newest. That's
deliberate: it keeps a tick to a single fetch, a single validation, and a single post per player.

## Setup

### Prerequisites

- [Deno](https://deno.com/) 2.x
- A [Clash Royale API](https://developer.clashroyale.com/) token, whitelisted to the
  [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) IP
- A Discord channel [webhook URL](https://support.discord.com/hc/en-us/articles/228383668) per
  player you want to track

### 1. Install

```sh
deno install
```

### 2. Configure

Copy `.env.example` to `.env` (gitignored) and fill it in:

```sh
cp .env.example .env
```

```sh
CR_API_TOKEN=...
TARGETS='[{ "tag": "#A9AA008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" }]'
```

`TARGETS` is a JSON array pairing each player tag (keep the leading `#`) with the webhook to notify.
Add as many as you like:

```json
[
	{ "tag": "#A9AA008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" },
	{ "tag": "#P7BB114L", "webhook": "https://discord.com/api/webhooks/ccc/ddd" }
]
```

> **Wrap the `TARGETS` value in single quotes.** The `#` in a player tag would otherwise start a
> comment and silently truncate the value.

A malformed `TARGETS` fails soft: it logs once and polls nobody, instead of throwing on every tick.
A missing `CR_API_TOKEN` skips each tick with a heartbeat log, so a misconfigured deploy shows up
loudly rather than as a silent dashboard.

### 3. Run locally

```sh
deno task dev
```

Runs with `.env` loaded, serving `GET /` (health check) and `GET /kv/last-battle` (a read-only dump
of the stored cursors). `-P` loads the `default` permission set from `deno.json` instead of
prompting per-permission. `Deno.cron` registers at startup and fires on the minute against Deno's
local scheduler.

### 4. Deploy

Set `CR_API_TOKEN` and `TARGETS` in the Deno Deploy project (dashboard), then connect the project to
this GitHub repo — Deno Deploy builds and deploys on every push, so there's no local deploy command.
Deno KV and `Deno.cron` are provisioned automatically — no namespace to create. The `images/` card
art is committed to the repo and deployed with it; the renderer depends on it in production.

## Commands

```sh
deno task dev     # Local dev server

deno task test     # Vitest suite
deno task preview  # Render a hardcoded deck to scripts/preview.png, for eyeballing layout changes
deno task measure  # Report the transparent margins baked into the card icons

deno task fmt         # Format (oxfmt)
deno task lint        # oxlint && deno lint && deno check
deno task sync-types  # Regenerate the vendored deno.d.ts, after a Deno version change
```

`deno task lint` covers linting _and_ typechecking — there's no separate `tsc` step. CI runs format,
lint, and test on every push and PR.

## Configuration reference

| Name           | Kind     | Purpose                                                                      |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `CR_API_TOKEN` | Env var  | Bearer token for the Clash Royale API, whitelisted to the RoyaleAPI proxy IP |
| `TARGETS`      | Env var  | JSON array of `{ tag, webhook }` pairs, one per tracked player               |
| Deno KV        | KV store | Holds the `["lastBattle", tag]` cursors, 30-day TTL                          |

Both env vars are read and validated once at module load (`src/env.ts`) — from `.env` locally, from
the project settings in production. Nothing secret is stored in KV, which is why the cursor route is
safe to expose.

## Project layout

| Path                       | Contents                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`              | Entry point: HTTP routes, cron registration, per-tick tally                                                                                               |
| `src/poll.ts`              | The polling loop — cursor read/compare/advance, one outcome per player                                                                                    |
| `src/clashroyale.ts`       | Battle-log fetch and newest-eligible-battle selection                                                                                                     |
| `src/discord.ts`           | Webhook message construction and delivery, with a text-only fallback                                                                                      |
| `src/deck-image.ts`        | Deck grids composited from local card art via [sharp](https://sharp.pixelplumbing.com/); tuning log in [`docs/deck-rendering.md`](docs/deck-rendering.md) |
| `src/schema.ts`            | Valibot schemas for the API shapes and the env vars                                                                                                       |
| `src/env.ts`, `src/log.ts` | Validated config; leveled, colored console output                                                                                                         |
| `src/*.test.ts`            | Vitest suite, colocated next to each module                                                                                                               |
| `images/`                  | 177 card-art PNGs, keyed by card id (plus `-evo`/`-hero` variants)                                                                                        |
| `scripts/`                 | Offline dev tools behind `deno task preview` / `deno task measure`                                                                                        |

Deck grids are composited from the local `images/` mirror rather than fetched per render, cached by
deck (players repeat decks, so most battles skip rendering entirely), and shipped at native
resolution with no downscale step — a shipped 8-card grid is 1080 px wide and about 3.28 MiB, stored
uncompressed to keep encode CPU down. A CDN fetch is the fallback for a
card too new to be in the mirror; if rendering fails outright, the battle still posts as a text-only
embed.

Working on the code? `.claude/CLAUDE.md` documents the toolchain setup, the invariants, and the
traps. `docs/deck-rendering.md` documents every deck-rendering constant's value and rationale.
