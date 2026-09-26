# CLAUDE.md

stalk is a Deno app on Deno Deploy. A `Deno.cron` job runs every minute, fetches each tracked Clash
Royale player's battle log through the RoyaleAPI proxy, and posts the player's newest 1v1 to their
Discord webhook with an image of each deck. [README.md](../README.md) covers setup, deployment, and
how a tick works.

## Commands

```sh
pnpm start       # Local server and cron, with .env loaded
pnpm test        # Vitest
pnpm fmt         # oxfmt
pnpm lint-agent  # oxlint (agent output) + deno lint + deno check
pnpm preview     # Render a sample deck to scripts/preview.png
pnpm measure     # Card-art margins behind the cell constants in src/deck-image.ts
pnpm sync-types  # Regenerate deno.d.ts after a Deno version change
```

- `pnpm lint-agent` is the one check command, type checking included. Don't run `tsc` or a separate
  `deno check`.
- `deno` is not on PATH. pnpm installs the pinned Deno at `node_modules/deno/deno`; run one-off
  commands with `pnpm exec deno ...`.
- Scripts live in `package.json`, not in `deno.jsonc` tasks.
- A hook in `.claude/settings.json` runs `pnpm fmt` after every Write and Edit, so a file can change
  on disk right after you edit it.
- CI runs `pnpm fmt --check`, `pnpm lint` and `pnpm test`.

## Modules

| File                  | Role                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `src/main.ts`         | Wiring: Hono routes, `Deno.serve`, the cron job, the per-tick tally       |
| `src/poll.ts`         | One tick: read lastBattle from KV, poll each target, write lastBattle     |
| `src/clash-royale.ts` | Battle-log fetch; picks the newest 1v1 and validates only that entry      |
| `src/discord.ts`      | Builds and posts the webhook message, with a text-only fallback           |
| `src/deck-image.ts`   | Renders a deck as a PNG grid with sharp, from the art in `images/`        |
| `src/schema.ts`       | Valibot schemas for the API and the env vars, plus the `EVOLUTIONS` table |
| `src/env.ts`          | Reads and validates `CR_API_TOKEN` and `TARGETS` once, into `config`      |
| `src/log.ts`          | Leveled console output and color helpers                                  |

Each module's `@module` JSDoc explains its design, and each constant's JSDoc explains its value.

## Rules that span modules

No single file shows these, and tests don't catch every way to break them.

- **One post per player per tick, for the newest battle.** `latestBattle` returns the first 1v1 in
  the newest-first log, and `poll` posts only that one.
- **lastBattle is written only after the post succeeds.** Keep `kv.set` after `notifyBattle` in
  `poll`. A failed write re-posts on the next tick, which is the intended at-least-once delivery.
- **`poll` and `pollAll` never reject.** `main.ts` awaits `pollAll` without a `catch`, then logs
  the tally. An `await` added to `pollAll` goes inside its `try`.
- **One KV read per tick.** `pollAll` calls `listLastBattles` once and hands each `poll` its value.
  Never add a per-player `kv.get` to the polling path: KV read units are the free tier's tightest
  quota.
- **Every webhook body goes through `payloadJson`** in `discord.ts`, which adds
  `allowed_mentions: { parse: [] }`. The message contains the opponent's name, which is untrusted
  text.
- **`log.ts` is the only module that imports `@std/fmt/colors`.** Color with `hl` and `levelColor`.
- **`images/` must ship with every deploy.** The renderer reads card art from it and uses the CDN only
  for a card with no file. After adding art, run `pnpm measure` and check `CELL_WIDTH`,
  `CELL_HEIGHT` and `ROW_GAP` against it.
- **A new `evolutionLevel` needs an `EVOLUTIONS` entry** in `schema.ts`. The `satisfies` clause
  fails to compile until it has one.

## Testing

- Vitest runs under Deno, so `Deno.*` is the real API. Spy on it directly
  (`vi.spyOn(Deno, "openKv")`) instead of adding a wrapper to mock.
- `poll.ts`, `main.ts` and `env.ts` do their work while the module is evaluated. Their tests
  install spies or stub env vars, call `vi.resetModules()`, then import the module dynamically. Take
  `log` from the same fresh import, or it will be a different instance.
- `spyMemoryKv()` (`src/testing/kv.ts`) gives a test its own in-memory KV. Call it inside the test
  body, not in a hook.
- `vi.mock(import("@/log.ts"))` with no factory uses `src/__mocks__/log.ts`. Always pass
  `import(...)`, not a path string; lint enforces it.
- `src/testing/fixtures.ts` has raw, pre-validation API shapes: `rawCard`, `rawPlayer`,
  `rawBattle`, `driftedBattle`, `duelBattle`, `BOB` and `WEBHOOK`.
- No test uses `.concurrent`, because tests share stubbed globals.
- The deck-image tests use generated fixtures, not real card art. After changing trimming or
  cropping, check the result with `pnpm preview`.
- A throwaway script that imports project dependencies must live inside the repo, such as in
  `scripts/`, because Deno resolves `node_modules` from the repo root. Delete it afterwards.

## Code style

- **Tabs** for indentation, and trailing commas where ES5 allows them. oxfmt enforces both.
- **Imports** are sorted ascending, case-insensitive, in groups separated by a blank line: side
  effects, builtins, packages, internal (`@/`), relative. Internal imports use the `@/` alias with an
  explicit `.ts` extension. When a module has both a type import and a value import, write
  `import type` first; oxfmt keeps the order you write.
- **No ambient globals for runtime values.** Import them, such as
  `import { Buffer } from "node:buffer"` in the builtins group, even where Deno would resolve the
  global. Platform globals like `fetch`, `Response`, `Deno.*`, `Temporal` and `performance` are
  fine.
- **Exports go at the bottom** of each module: plain declarations in the body, then one sorted
  `export { … }` and a separate `export type { … }`, with no inline `export`. A module may split its
  exports into a production group and an `@internal` group for tests and scripts, as
  `deck-image.ts` and `discord.ts` do.
- **Return types and generic type arguments are inferred by default.** Write one only when inference
  gives a worse type: when it loses a named alias (`Promise<BattleLog>` becoming
  `Promise<unknown[]>`), widens a literal union (`PollOutcome` becoming `string`), or lets an `any`
  through where the annotation can say `unknown`.
- **Comments** explain the code as it is now: what it guarantees, why, and the measurements behind a
  number. They don't describe how the code used to be. Every file in `src/` and `scripts/` starts
  with an `@module` JSDoc.
