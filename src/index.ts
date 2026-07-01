import { Hono } from "@hono/hono";
import * as v from "@valibot/valibot";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { notifyBattle } from "@/discord.ts";
import { TargetsSchema, type Target } from "@/schema.ts";

const app = new Hono();

/** Health check endpoint for Deno Deploy health checks. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

// One KV handle for the isolate's lifetime; Deno.openKv() opens the Deploy-managed store.
const kv = await Deno.openKv();

async function poll(target: Target, token: string) {
	const { tag, webhook } = target;
	try {
		const entries = await fetchBattlelog(tag, token);
		const latest = latestBattle(entries);
		if (latest === undefined) return;

		// Cursor is namespaced per tag, so multiple players share one KV without colliding.
		const key = ["lastBattle", tag];
		const { value: lastSeen } = await kv.get<string>(key);

		// No new battles since the last run; nothing to do.
		if (latest.battleTime === lastSeen) return;

		// First run: seed the cursor without posting a possibly-stale battle.
		if (lastSeen !== null) {
			await notifyBattle(webhook, tag, latest);
		}

		// Advance the cursor only after a successful post: at-least-once delivery. If the webhook
		// succeeds but this put throws, the next run re-posts a duplicate rather than dropping the
		// battle — we prefer a rare duplicate over a lost notification.
		await kv.set(key, latest.battleTime);
	} catch (error) {
		// Log and move on; the next cron run retries without overwriting the cursor.
		console.error(`Poll failed for ${tag}:`, error);
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

	let targets: Target[];
	try {
		targets = v.parse(TargetsSchema, JSON.parse(Deno.env.get("TARGETS") ?? ""));
	} catch (error) {
		console.error("Invalid TARGETS env var:", error);
		targets = [];
	}

	cachedConfig = { token, targets };
	return cachedConfig;
}

// Poll every minute. Deno.cron registers at module load and runs on Deno Deploy's scheduler.
Deno.cron("poll-battlelogs", "*/1 * * * *", async () => {
	// Can't poll without a token; loadConfig has already logged the reason.
	const { token, targets } = loadConfig();
	if (token === undefined) return;

	// allSettled so one player's failure can't sink the others.
	await Promise.allSettled(targets.map((target) => poll(target, token)));
});

export default app;
