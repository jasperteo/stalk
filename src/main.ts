import { Hono } from "hono";

import { configureDeckCache } from "@/deck-image.ts";
import { config } from "@/env.ts";
import { hl, levelColor, log } from "@/log.ts";
import { listCursors, POLL_OUTCOMES, pollAll } from "@/poll.ts";
import type { PollOutcome } from "@/poll.ts";

const app = new Hono();

/** Health check endpoint for Deno Deploy. */
app.get("/", (ctx) => ctx.json({ status: "ok" }));

/** Read-only view of the lastBattle cursors; no secrets live in KV, so this is safe to expose. */
app.get("/kv/last-battle", async (ctx) => ctx.json(await listCursors()));

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

// Each outcome borrows its corresponding level's badge color, so the tally stays in sync with the
// badges by construction.
const outcomeColor: Record<PollOutcome, (str: string) => string> = {
	posted: levelColor.ok,
	seeded: levelColor.info,
	skipped: levelColor.debug,
	drifted: levelColor.warn,
	failed: levelColor.error,
};

// Runs once at startup, not per tick: sizes the renderer's deck-cache entry-count guard from the
// live target count so the renderer itself never reads app config.
if (config !== undefined) {
	configureDeckCache(config.targets.length);
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

	// pollAll owns the fan-out (and the tick's single cursor read) so the KV handle stays inside
	// poll.ts; this stays wiring.
	const outcomes = await pollAll(targets, token);

	// Seeded from POLL_OUTCOMES rather than a hand-written literal, so adding an outcome doesn't
	// need a matching edit here to keep its count off the tally line.
	const tally = Object.fromEntries(POLL_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
		PollOutcome,
		number
	>;

	for (const outcome of outcomes) {
		tally[outcome]++;
	}

	// One heartbeat line per tick; iterates POLL_OUTCOMES so a new outcome can't go missing.
	const counts = POLL_OUTCOMES.map((outcome) =>
		outcomeColor[outcome](`${outcome} ${String(tally[outcome])}`)
	).join(", ");

	log.info(`poll-battlelogs: ${String(targets.length)} targets — ${counts}`);
});

/**
 * Vite-style quit key: `q` + Enter shuts the server down. `Deno.exit()` would skip the graceful
 * `server.shutdown()` below, so this closes the server first and then signals our own pid, exiting
 * the same way Ctrl+C would.
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
