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

async function poll(target: Target) {
	const { tag, webhook } = target;
	try {
		const token = Deno.env.get("CR_API_TOKEN");
		if (token === undefined) throw new Error("CR_API_TOKEN is not set");

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

// Memoized: TARGETS is constant for the isolate's lifetime (changing it redeploys onto a fresh
// isolate), so parse once per isolate instead of once per cron tick.
let cachedTargets: Target[] | undefined;

/**
 * Parse the TARGETS env var, failing soft: a malformed value logs once and polls nobody rather than
 * throwing on every cron tick.
 */
function parseTargets(): Target[] {
	if (cachedTargets !== undefined) return cachedTargets;
	try {
		cachedTargets = v.parse(TargetsSchema, JSON.parse(Deno.env.get("TARGETS") ?? ""));
	} catch (error) {
		console.error("Invalid TARGETS env var:", error);
		cachedTargets = [];
	}
	return cachedTargets;
}

// Poll every minute. Deno.cron registers at module load and runs on Deno Deploy's scheduler.
Deno.cron("poll-battlelogs", "*/1 * * * *", async () => {
	// allSettled so one player's failure can't sink the others.
	await Promise.allSettled(parseTargets().map((target) => poll(target)));
});

export default app;
