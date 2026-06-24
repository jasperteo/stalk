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

This is a **Cloudflare Workers** application built with **Hono**. The entry point is `src/index.ts`, which exports a default Hono app instance. Wrangler bundles and deploys it.

When Cloudflare bindings (KV, R2, D1, AI, etc.) are added to `wrangler.jsonc`, run `pnpm cf-typegen` to update the generated types, then pass `CloudflareBindings` as a generic to the Hono instance:

```ts
const app = new Hono<{ Bindings: CloudflareBindings }>();
```

## Code style

- **Tabs** for indentation (enforced by oxfmt)
- **Trailing commas** in ES5 positions
- **Imports** sorted ascending, case-insensitive, grouped with blank lines between: side effects → builtins → external → internal (`~/`, `@/`) → relative → styles
- oxlint runs with `typescript`, `unicorn`, and `oxc` plugins at `correctness: error`, with type-aware checking enabled
