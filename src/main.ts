import { Hono } from "@hono/hono";
import * as v from "@valibot/valibot";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { notifyBattle } from "@/discord.ts";
import { config } from "@/env.ts";
import { hl, levelColor, log } from "@/log.ts";
import { CursorSchema } from "@/schema.ts";
import type { Target } from "@/schema.ts";

const app = new Hono();

/** One KV handle for the isolate's lifetime; Deno.openKv() opens the Deploy-managed store. */
const kv = await Deno.openKv();

/**
 * Cursor key, shared by poll() and the read-only endpoint; namespaced per tag so multiple players
 * share one KV without colliding.
 */
const LAST_BATTLE_PREFIX = "lastBattle";
const lastBattleKey = (tag: string) => [LAST_BATTLE_PREFIX, tag] as const;

/**
 * Cursors self-expire so players removed from TARGETS don't leave garbage in KV forever. Every
 * posted/seeded battle resets the clock; an expired cursor just re-seeds silently, like a first
 * run. Pinned to 30 days since Temporal can't total calendar months without a reference point.
 */
const CURSOR_TTL_MS = Temporal.Duration.from({ days: 30 }).total("milliseconds");

/** Health check endpoint for Deno Deploy. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

/** Read-only view of the lastBattle cursors; no secrets live in KV, so this is safe to expose. */
app.get("/kv/last-battle", async (ctx) => {
	// Raw values on purpose — interpreting cursors (validation, first-run vs. corrupt) is poll()'s
	// job.
	const cursors: Record<string, unknown> = {};

	for await (const entry of kv.list({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;
		cursors[String(tag)] = entry.value;
	}

	return ctx.json(cursors);
});

/** Per-target results of a poll, tallied into the cron tick's summary log line, in display order. */
const POLL_OUTCOMES = ["posted", "seeded", "skipped", "failed"] as const;
type PollOutcome = (typeof POLL_OUTCOMES)[number];

// Each outcome borrows its corresponding level's badge color, so the tally stays in sync with the
// badges by construction.
const outcomeColor: Record<PollOutcome, (str: string) => string> = {
	posted: levelColor.ok,
	seeded: levelColor.info,
	skipped: levelColor.debug,
	failed: levelColor.error,
};

async function poll(target: Target, token: string): Promise<PollOutcome> {
	const { tag, webhook } = target;

	try {
		const entries = await fetchBattlelog(tag, token);
		const latest = latestBattle(entries);

		if (latest === undefined) {
			return "skipped";
		}

		const key = lastBattleKey(tag);
		const { value: stored } = await kv.get(key);

		// null (first run) fails the parse too; only a non-null failure is corrupt, so re-seed
		// like a first run instead of re-posting every tick against a cursor that can never match.
		const cursor = v.safeParse(CursorSchema, stored);
		if (stored !== null && !cursor.success) {
			log.warn(`Corrupt lastBattle cursor for ${hl.entity(tag)}; re-seeding without posting`);
		}
		const lastSeen = cursor.success ? cursor.output : undefined;

		if (latest.battleTime === lastSeen) {
			return "skipped";
		}

		// First run (or corrupt cursor): seed without posting a possibly-stale battle.
		const isFirstRun = lastSeen === undefined;

		if (!isFirstRun) {
			await notifyBattle(webhook, latest);
		}

		// Advance the cursor only after a successful post: at-least-once delivery. If the webhook
		// succeeds but this put throws, the next run re-posts a duplicate rather than drops the battle.
		await kv.set(key, latest.battleTime, { expireIn: CURSOR_TTL_MS });

		if (isFirstRun) {
			log.info(`Seeded cursor for ${hl.entity(tag)} (first run, no notification sent)`);
			return "seeded";
		}

		log.success(`Posted battle for ${hl.entity(tag)} at ${latest.battleTime}`);
		return "posted";
	} catch (error) {
		// Next cron run retries without overwriting the cursor.
		log.error(`Poll failed for ${hl.entity(tag)}:`, error);
		return "failed";
	}
}

// The registration promise only surfaces registration errors and must not be awaited (the job
// runs for the isolate's lifetime), so it's voided to satisfy no-floating-promises.
void Deno.cron("poll-battlelogs", { minute: { every: 1 } }, async () => {
	// Still emit a heartbeat so a misconfigured deploy shows up as a loud skipped tick, not a
	// silent dashboard.
	if (config === undefined) {
		log.warn("poll-battlelogs: skipped tick — CR_API_TOKEN not set");
		return;
	}

	const { token, targets } = config;

	// poll() catches its own errors and resolves "failed" — no rejection path, hence Promise.all
	// over allSettled.
	const outcomes = await Promise.all(targets.map((target) => poll(target, token)));

	const tally: Record<PollOutcome, number> = { posted: 0, seeded: 0, skipped: 0, failed: 0 };
	for (const outcome of outcomes) {
		tally[outcome]++;
	}

	// One heartbeat line per tick; iterates POLL_OUTCOMES so a new outcome can't go missing.
	const counts = POLL_OUTCOMES.map((outcome) =>
		outcomeColor[outcome](`${outcome} ${String(tally[outcome])}`)
	).join(", ");

	log.info(`poll-battlelogs: ${String(targets.length)} targets — ${counts}`);
});

// Gated on stdin being a TTY: under Deno Deploy or any piped/captured stdin, reading a quit key
// would just hang on a stream that never yields.
const interactive = Deno.stdin.isTerminal();

const server = Deno.serve({
	handler: app.fetch,
	onListen: ({ hostname, port }) => {
		const status = config
			? `tracking ${String(config.targets.length)} target(s)`
			: "idle (CR_API_TOKEN not set)";
		const quit = interactive ? ` — ${hl.strong("q")} + Enter to quit` : "";
		log.info(
			`stalk listening on ${hl.value(`http://${hostname}:${String(port)}`)} — ${status}${quit}`
		);
	},
});

/**
 * Vite-style quit key: `q` + Enter shuts the server down. `Deno.exit()` isn't enough — under
 * `--watch`/`--watch-hmr` it only ends the module run and leaves the watcher supervising an empty
 * process — so this signals our own pid instead, tearing down the watcher just like Ctrl+C.
 */
async function quitOnKeypress() {
	const decoder = new TextDecoder();

	for await (const chunk of Deno.stdin.readable) {
		if (decoder.decode(chunk).trim().toLowerCase() !== "q") continue;

		log.info("Shutting down");
		await server.shutdown();
		Deno.kill(Deno.pid, "SIGINT");
	}
}

if (interactive) {
	await quitOnKeypress();
}
