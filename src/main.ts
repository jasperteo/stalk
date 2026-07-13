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
 * Single definition of the cursor key schema, shared by poll() and the read-only endpoint so the
 * two can't drift. Keys are namespaced per tag, so multiple players share one KV without
 * colliding.
 */
const LAST_BATTLE_PREFIX = "lastBattle";
const lastBattleKey = (tag: string) => [LAST_BATTLE_PREFIX, tag] as const;

/** Health check endpoint for Deno Deploy. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

/** Read-only view of the lastBattle cursors; no secrets live in KV, so this is safe to expose. */
app.get("/kv/last-battle", async (ctx) => {
	// Values pass through raw on purpose: this debug view's job is to show exactly what's stored;
	// interpreting cursors (validation, first-run vs. corrupt) is poll()'s.
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

// Each outcome borrows the badge color of the level it corresponds to (posted~ok, seeded~info,
// failed~error; skipped gets debug's gray since a skip isn't actionable), so the heartbeat tally
// reads like a mini heat-map that stays in sync with the badges by construction.
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

		// null (first run) fails the parse too; only a non-null failure is corrupt — warn and
		// re-seed like a first run rather than re-posting every tick against a cursor that can
		// never match.
		const cursor = v.safeParse(CursorSchema, stored);
		if (stored !== null && !cursor.success) {
			log.warn(`Corrupt lastBattle cursor for ${hl.entity(tag)}; re-seeding without posting`);
		}
		const lastSeen = cursor.success ? cursor.output : undefined;

		// No new battles since the last run; nothing to do.
		if (latest.battleTime === lastSeen) {
			return "skipped";
		}

		// First run (or corrupt cursor): seed without posting a possibly-stale battle.
		const isFirstRun = lastSeen === undefined;

		if (!isFirstRun) {
			await notifyBattle(webhook, latest);
		}

		// Advance the cursor only after a successful post: at-least-once delivery. If the webhook
		// succeeds but this put throws, the next run re-posts a duplicate rather than dropping the
		// battle — we prefer a rare duplicate over a lost notification.
		await kv.set(key, latest.battleTime);

		// Log only after the effects landed, so the dashboard never claims an action that didn't
		// happen.
		if (isFirstRun) {
			log.info(`Seeded cursor for ${hl.entity(tag)} (first run, no notification sent)`);
			return "seeded";
		}

		log.success(`Posted battle for ${hl.entity(tag)} at ${latest.battleTime}`);
		return "posted";
	} catch (error) {
		// Log and move on; the next cron run retries without overwriting the cursor.
		log.error(`Poll failed for ${hl.entity(tag)}:`, error);
		return "failed";
	}
}

// Poll every minute. Deno.cron registers at module load and runs on Deno Deploy's scheduler.
// The returned promise only surfaces registration errors and must not be awaited (the job runs
// for the isolate's lifetime), so we void it to satisfy no-floating-promises; a failed
// registration still shows up as the absence of heartbeat lines on the dashboard.
void Deno.cron("poll-battlelogs", { minute: { every: 1 } }, async () => {
	// Can't poll without a token; env.ts already logged why, once. Still emit a heartbeat so a
	// misconfigured deploy shows up as a loud skipped tick, not a silent dashboard.
	if (config === undefined) {
		log.warn("poll-battlelogs: skipped tick — CR_API_TOKEN not set");
		return;
	}

	const { token, targets } = config;

	// poll() catches its own errors and resolves "failed", so one player's failure can't sink the
	// others — no rejection path, hence Promise.all over allSettled.
	const outcomes = await Promise.all(targets.map((target) => poll(target, token)));

	const tally: Record<PollOutcome, number> = { posted: 0, seeded: 0, skipped: 0, failed: 0 };
	for (const outcome of outcomes) {
		tally[outcome]++;
	}

	// Heartbeat: one line per tick so a quiet minute still shows up on the Deno Deploy dashboard.
	// Counts iterate POLL_OUTCOMES, which PollOutcome derives from — so a new outcome can't go
	// missing here, and the summary order is fixed by declaration rather than insertion.
	const counts = POLL_OUTCOMES.map((outcome) =>
		outcomeColor[outcome](`${outcome} ${String(tally[outcome])}`)
	).join(", ");

	log.info(`poll-battlelogs: ${String(targets.length)} targets — ${counts}`);
});

// Only an interactive terminal has a keyboard to read a quit key from; under Deno Deploy (or any
// piped/captured stdin) the reader would just hang on a stream that never yields, so the whole
// feature — hint included — is gated on stdin being a TTY.
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
 * Vite-style quit key: `q` + Enter shuts the server down. Deno.exit() would not be enough — under
 * `--watch`/`--watch-hmr` it only ends the module run and leaves the watcher supervising an empty
 * process — so signal our own pid instead, which tears down watcher and all exactly like Ctrl+C.
 *
 * Awaiting this at the top level never settles until the process is on its way out, which is fine:
 * the listener is already registered, so the event loop keeps serving requests regardless.
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
