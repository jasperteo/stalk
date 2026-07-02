import { Hono } from "@hono/hono";
import * as v from "@valibot/valibot";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { notifyBattle } from "@/discord.ts";
import { TargetsEnvSchema, type Target } from "@/schema.ts";

const app = new Hono();

// One KV handle for the isolate's lifetime; Deno.openKv() opens the Deploy-managed store.
const kv = await Deno.openKv();

// Single definition of the cursor key schema, shared by poll() and the read-only endpoint so the
// two can't drift. Keys are namespaced per tag, so multiple players share one KV without colliding.
const LAST_BATTLE_PREFIX = "lastBattle";
const lastBattleKey = (tag: string) => [LAST_BATTLE_PREFIX, tag] as const;

/** Health check endpoint for Deno Deploy health checks. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

/** Read-only view of the lastBattle cursors; no secrets live in KV, so this is safe to expose. */
app.get("/kv/last-battle", async (ctx) => {
	const cursors: Record<string, string> = {};
	for await (const entry of kv.list<string>({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;
		cursors[String(tag)] = entry.value;
	}
	return ctx.json(cursors);
});

/** Per-target result of a poll, tallied into the cron tick's summary log line. */
type PollOutcome = "posted" | "seeded" | "skipped" | "failed";

async function poll(target: Target, token: string): Promise<PollOutcome> {
	const { tag, webhook } = target;
	try {
		const entries = await fetchBattlelog(tag, token);
		const latest = latestBattle(entries);
		if (latest === undefined) return "skipped";

		const key = lastBattleKey(tag);
		const { value: lastSeen } = await kv.get<string>(key);

		// No new battles since the last run; nothing to do.
		if (latest.battleTime === lastSeen) return "skipped";

		// First run: seed the cursor without posting a possibly-stale battle.
		const isFirstRun = lastSeen === null;
		if (!isFirstRun) await notifyBattle(webhook, tag, latest);

		// Advance the cursor only after a successful post: at-least-once delivery. If the webhook
		// succeeds but this put throws, the next run re-posts a duplicate rather than dropping the
		// battle — we prefer a rare duplicate over a lost notification.
		await kv.set(key, latest.battleTime);

		// Log only after the effects landed, so the dashboard never claims an action that didn't happen.
		if (isFirstRun) {
			console.log(`Seeded cursor for ${tag} (first run, no notification sent)`);
			return "seeded";
		}
		console.log(`Posted battle for ${tag} at ${latest.battleTime}`);
		return "posted";
	} catch (error) {
		// Log and move on; the next cron run retries without overwriting the cursor.
		console.error(`Poll failed for ${tag}:`, error);
		return "failed";
	}
}

// Memoized: env vars are constant for the isolate's lifetime (changing one redeploys onto a fresh
// isolate), so read and validate config once per isolate instead of once per cron tick. Both reads
// fail soft — a missing token or malformed TARGETS logs once and polls nobody rather than throwing
// every tick.
let cachedConfig: { token: string | undefined; targets: Target[] } | undefined;

function loadConfig() {
	if (cachedConfig !== undefined) return cachedConfig;

	const token = Deno.env.get("CR_API_TOKEN");
	if (token === undefined) console.error("CR_API_TOKEN is not set");

	const parsed = v.safeParse(TargetsEnvSchema, Deno.env.get("TARGETS"));
	if (!parsed.success) console.error("Invalid TARGETS env var:", v.flatten(parsed.issues));
	const targets = parsed.success ? parsed.output : [];

	cachedConfig = { token, targets };
	return cachedConfig;
}

// Poll every minute. Deno.cron registers at module load and runs on Deno Deploy's scheduler.
Deno.cron("poll-battlelogs", "*/1 * * * *", async () => {
	const { token, targets } = loadConfig();

	// Can't poll without a token; loadConfig already logged why, once. Still emit a heartbeat so a
	// misconfigured deploy shows up as a loud skipped tick, not a silent dashboard.
	if (token === undefined) {
		console.log("poll-battlelogs: skipped tick — CR_API_TOKEN not set");
		return;
	}

	// poll() catches its own errors and resolves "failed", so one player's failure can't sink the
	// others — no rejection path, hence Promise.all over allSettled.
	const outcomes = await Promise.all(targets.map((target) => poll(target, token)));

	const tally: Record<PollOutcome, number> = { posted: 0, seeded: 0, skipped: 0, failed: 0 };
	for (const outcome of outcomes) tally[outcome]++;

	// Heartbeat: one line per tick so a quiet minute still shows up on the Deno Deploy dashboard.
	// Counts are derived from the tally record, so a new PollOutcome can't go missing here.
	const counts = Object.entries(tally)
		.map(([outcome, count]) => `${outcome} ${String(count)}`)
		.join(", ");
	console.log(`poll-battlelogs: ${String(targets.length)} targets — ${counts}`);
});

export default app;
