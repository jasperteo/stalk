import { Hono } from "hono";

import { fetchBattlelog } from "@/clashroyale";
import { notifyBattle } from "@/discord";
import { latestBattle } from "@/tracker";

type Env = CloudflareBindings & {
	CR_API_TOKEN: string;
	DISCORD_WEBHOOK_URL: string;
};

async function poll(env: Env) {
	const playerTag = env.PLAYER_TAG;
	try {
		const battles = await fetchBattlelog(playerTag, env.CR_API_TOKEN);
		const latest = latestBattle(battles);
		if (latest === undefined) return;

		const key = `lastBattle:${playerTag}`;
		// KV returns null for a missing key; normalize to undefined.
		const lastSeen = (await env.STALK_KV.get(key)) ?? undefined;
		if (latest.battleTime === lastSeen) return;

		// First run: seed the cursor without posting a possibly-stale battle.
		if (lastSeen !== undefined) {
			await notifyBattle(env.DISCORD_WEBHOOK_URL, playerTag, latest);
		}
		await env.STALK_KV.put(key, latest.battleTime);
	} catch (error) {
		// Log and move on; the next cron run retries without overwriting the cursor.
		console.error(`Poll failed for ${playerTag}:`, error);
	}
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("stalk: ok"));

const handler: ExportedHandler<Env> = {
	fetch: app.fetch,
	scheduled: (_event, env: Env, ctx) => {
		ctx.waitUntil(poll(env));
	},
};

export default handler;
