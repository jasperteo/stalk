/**
 * @module
 *
 * The entry point. It runs under `deno run`, not `deno serve`, so it has no default export. It only
 * wires the other modules together:
 *
 * - an HTTP server (Hono) with a health check and a read-only dump of the stored lastBattle values;
 * - the `poll-battlelogs` cron job, which calls {@link pollAll} once a minute and logs a tally.
 *
 * Deno Deploy waits for an instance's HTTP server to start before it counts the instance as running,
 * so the server has to exist even though the real work happens in the cron job.
 */

import { Hono } from "hono";

import { config } from "@/env.ts";
import { hl, levelColor, log } from "@/log.ts";
import type { PollOutcome } from "@/poll.ts";
import { listLastBattles, POLL_OUTCOMES, pollAll } from "@/poll.ts";

// ════════════════════════════════════════════ SERVER ═════════════════════════════════════════════

const app = new Hono();

// Health check.
app.get("/", (ctx) => ctx.json({ status: "ok" }));

// Every stored lastBattle value, keyed by tag, exactly as stored. KV holds only player tags and
// battle times, which are public, so the route needs no authentication.
app.get("/kv/last-battle", async (ctx) => ctx.json(Object.fromEntries(await listLastBattles())));

Deno.serve({
	handler: app.fetch,
	// Runs once per instance, when the server starts listening. On Deno Deploy most ticks start a new
	// instance, so this line appears about once a tick and shows whether the instance has a token.
	onListen: ({ hostname, port }) => {
		const status = config
			? `tracking ${String(config.targets.length)} target(s)`
			: "idle (CR_API_TOKEN not set)";

		log.info(`stalk listening on ${hl.value(`http://${hostname}:${String(port)}`)} — ${status}`);
	},
});

// ═════════════════════════════════════════════ CRON ══════════════════════════════════════════════

/**
 * The color of each outcome in the tally line. `posted`, `seeded`, `drifted` and `failed` take the
 * badge color of the level they are logged at (`success`, `info`, `warn` and `error`). `skipped` is
 * the usual quiet result and takes the gray of `debug`.
 */
const outcomeColor: Record<PollOutcome, (str: string) => string> = {
	posted: levelColor.ok,
	seeded: levelColor.info,
	skipped: levelColor.debug,
	drifted: levelColor.warn,
	failed: levelColor.error,
};

/**
 * Formats a tick's tally, such as `posted 1, seeded 0, skipped 7, drifted 0, failed 1`.
 *
 * @param outcomes One outcome per target, as {@link pollAll} returns them.
 * @returns Every outcome in {@link POLL_OUTCOMES} order, zero counts included, each in its own
 *   color. Keeping the zeros gives every tick's line the same shape, so ticks compare at a glance.
 *   Building the line from `POLL_OUTCOMES` means a new outcome appears here without a change to
 *   this function.
 */
function formatTally(outcomes: PollOutcome[]) {
	const counts = new Map<PollOutcome, number>();

	for (const outcome of outcomes) {
		counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	}

	return POLL_OUTCOMES.map((outcome) =>
		outcomeColor[outcome](`${outcome} ${String(counts.get(outcome) ?? 0)}`)
	).join(", ");
}

// `Deno.cron` registers the job and returns at once. Its promise exists only to report a registration
// error, and the job runs for as long as the process does, so the promise is not awaited. Deno Deploy
// skips a run while the previous one is still going, and does not retry a failed run.
void Deno.cron("poll-battlelogs", { minute: { every: 1 } }, async () => {
	// Without a token there is nothing to poll. Warn on every tick, so that a deploy missing its
	// token shows a line each minute in the logs instead of going silent.
	if (config === undefined) {
		log.warn("poll-battlelogs: skipped tick — CR_API_TOKEN not set");
		return;
	}

	const { token, targets } = config;

	// `pollAll` never rejects, so the tally line below always runs.
	const outcomes = await pollAll(targets, token);

	log.info(`poll-battlelogs: ${String(targets.length)} targets — ${formatTally(outcomes)}`);
});
