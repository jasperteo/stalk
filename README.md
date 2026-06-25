# stalk

A Cloudflare Worker that polls one or more Clash Royale players' battle logs every minute and posts results to a Discord channel via webhook. Each player is paired with its own webhook.

## Setup

### Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — Cloudflare Workers CLI (`pnpm add -g wrangler`)
- A [Clash Royale API](https://developer.clashroyale.com/) token, whitelisted to the [RoyaleAPI proxy](https://docs.royaleapi.com/#/proxy) IP
- A Discord channel [webhook URL](https://support.discord.com/hc/en-us/articles/228383668)

### 1. Create the KV namespace

```sh
wrangler kv namespace create STALK_KV
```

Copy the returned `id` into the `kv_namespaces` entry in `wrangler.jsonc`.

### 2. Set secrets

```sh
wrangler secret put CR_API_TOKEN
wrangler secret put TARGETS
```

`TARGETS` is a JSON array pairing each player tag (keep the leading `#`) with the Discord webhook to notify. Add as many entries as you want to track:

```json
[
	{ "tag": "#G9GY008R", "webhook": "https://discord.com/api/webhooks/aaa/bbb" },
	{ "tag": "#ABC123", "webhook": "https://discord.com/api/webhooks/ccc/ddd" }
]
```

### 3. Deploy

```sh
pnpm deploy
```

## Development

```sh
pnpm dev        # Start local dev server (does not fire cron triggers)
pnpm run fmt    # Format with oxfmt
pnpm run lint   # Lint with oxlint
```

Trigger the cron handler manually during local dev:

```sh
curl "http://localhost:8787/__scheduled?cron=*%2F1+*+*+*+*"
```

## How it works

1. A cron fires every minute and calls `poll(env, target)` in `src/index.ts` for each entry in `TARGETS`.
2. The latest battle is fetched from `https://proxy.royaleapi.dev/v1/players/<tag>/battlelog`.
3. Its `battleTime` is compared against a cursor stored in `STALK_KV` (`lastBattle:<tag>`). Cursors are namespaced per tag, so every player shares one KV namespace without colliding.
4. On the first run the cursor is seeded without posting, to avoid a stale notification.
5. On subsequent runs, if a new battle is found, a Discord embed is posted to that player's webhook and the cursor is updated.

Players are polled concurrently with `Promise.allSettled`, so one player's failure can't sink the others.

## Bindings

| Name           | Kind         | Purpose                                                        |
| -------------- | ------------ | -------------------------------------------------------------- |
| `STALK_KV`     | KV namespace | Persists the `lastBattle:<tag>` cursor                         |
| `CR_API_TOKEN` | Secret       | Clash Royale API bearer token                                  |
| `TARGETS`      | Secret       | JSON array of `{ tag, webhook }` pairs, one per tracked player |
