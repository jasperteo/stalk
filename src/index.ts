import { Hono } from "hono";
import * as v from "valibot";

import { fetchBattlelog, latestBattle } from "@/clashroyale";
import { notifyBattle } from "@/discord";
import { TargetsSchema, type Target } from "@/schema";

type Env = CloudflareBindings & {
	CR_API_TOKEN: string;
	// JSON array of { tag, webhook } pairs; see TargetsSchema.
	TARGETS: string;
};

const app = new Hono<{ Bindings: Env }>();

/** Health check endpoint for Workers Dev and Cloudflare health checks. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

async function poll(env: Env, target: Target) {
	const { tag, webhook } = target;
	try {
		const entries = await fetchBattlelog(tag, env.CR_API_TOKEN);
		const latest = latestBattle(entries);
		if (latest === undefined) return;

		// Cursor is namespaced per tag, so multiple players share one KV without colliding.
		const key = `lastBattle:${tag}`;
		const lastSeen = await env.STALK_KV.get(key);

		// No new battles since the last run; nothing to do.
		if (latest.battleTime === lastSeen) return;

		// First run: seed the cursor without posting a possibly-stale battle.
		if (lastSeen !== null) {
			await notifyBattle(webhook, tag, latest);
		}

		// Update the cursor to the latest battle time so that we don't post it again next run.
		await env.STALK_KV.put(key, latest.battleTime);
	} catch (error) {
		// Log and move on; the next cron run retries without overwriting the cursor.
		console.error(`Poll failed for ${tag}:`, error);
	}
}

/**
 * Parse the TARGETS secret, failing soft: a malformed secret logs once and polls nobody rather than
 * throwing on every cron tick.
 */
function parseTargets(env: Env): Target[] {
	try {
		return v.parse(TargetsSchema, JSON.parse(env.TARGETS));
	} catch (error) {
		console.error("Invalid TARGETS secret:", error);
		return [];
	}
}

const handler: ExportedHandler<Env> = {
	fetch: app.fetch,
	scheduled: (_controller, env, ctx) => {
		const targets = parseTargets(env);
		// allSettled so one player's failure can't sink the others.
		ctx.waitUntil(Promise.allSettled(targets.map((target) => poll(env, target))));
	},
};

export default handler;
