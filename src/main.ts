import { Hono } from "hono";

import { config } from "@/env.ts";
import { hl, levelColor, log } from "@/log.ts";
import { listLastBattles, POLL_OUTCOMES, pollAll } from "@/poll.ts";
import type { PollOutcome } from "@/poll.ts";

// ════════════════════════════════════════════ SERVER ═════════════════════════════════════════════

const app = new Hono();

/** Health check endpoint for Deno Deploy. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

/** Read-only lastBattle dump; no secrets live in KV, so this is safe to expose. */
app.get("/kv/last-battle", async (ctx) => ctx.json(Object.fromEntries(await listLastBattles())));

Deno.serve({
	handler: app.fetch,
	onListen: ({ hostname, port }) => {
		const status = config
			? `tracking ${String(config.targets.length)} target(s)`
			: "idle (CR_API_TOKEN not set)";

		log.info(`stalk listening on ${hl.value(`http://${hostname}:${String(port)}`)} — ${status}`);
	},
});

// ═════════════════════════════════════════════ CRON ══════════════════════════════════════════════

/** Each outcome borrows its level's badge color, so the tally stays in sync with the badges. */
const outcomeColor: Record<PollOutcome, (str: string) => string> = {
	posted: levelColor.ok,
	seeded: levelColor.info,
	skipped: levelColor.debug,
	drifted: levelColor.warn,
	failed: levelColor.error,
};

/**
 * `posted 1, seeded 0, …` — iterates {@link POLL_OUTCOMES} so a new outcome can't go missing.
 *
 * @returns Every outcome in display order, each painted in its own badge color, including the ones
 *   that counted zero — a stable line shape reads better across ticks than a variable one.
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

// Voided, not awaited: the registration promise only surfaces registration errors, and the job runs
// for the isolate's lifetime.
void Deno.cron("poll-battlelogs", { minute: { every: 1 } }, async () => {
	// Heartbeat so a misconfigured deploy shows up as a loud skipped tick in the logs, instead of
	// failing silently with nothing to see on the dashboard.
	if (config === undefined) {
		log.warn("poll-battlelogs: skipped tick — CR_API_TOKEN not set");
		return;
	}

	const { token, targets } = config;

	// pollAll owns the fan-out and the tick's single lastBattle read; this stays wiring.
	const outcomes = await pollAll(targets, token);

	log.info(`poll-battlelogs: ${String(targets.length)} targets — ${formatTally(outcomes)}`);
});
