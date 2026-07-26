import * as v from "@valibot/valibot";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { notifyBattle } from "@/discord.ts";
import { hl, log } from "@/log.ts";
import { CursorSchema } from "@/schema.ts";
import type { Target } from "@/schema.ts";

/** One KV handle for the isolate's lifetime; Deno.openKv() opens the Deploy-managed store. */
const kv = await Deno.openKv();

/**
 * Cursor key, shared by poll() and listCursors(); namespaced per tag so multiple players share one
 * KV without colliding.
 */
const LAST_BATTLE_PREFIX = "lastBattle";
const lastBattleKey = (tag: string) => [LAST_BATTLE_PREFIX, tag] as const;

/**
 * Cursors self-expire so players removed from TARGETS don't leave garbage in KV forever. Every
 * posted/seeded battle resets the clock; an expired cursor just re-seeds silently, like a first
 * run. Pinned to 30 days since Temporal can't total calendar months without a reference point.
 */
const CURSOR_TTL_MS = Temporal.Duration.from({ days: 30 }).total("milliseconds");

/** Per-target results of a poll, tallied into the cron tick's summary log line, in display order. */
const POLL_OUTCOMES = ["posted", "seeded", "skipped", "failed"] as const;
type PollOutcome = (typeof POLL_OUTCOMES)[number];

async function poll(target: Target, token: string): Promise<PollOutcome> {
	const { tag, webhook } = target;

	try {
		const entries = await fetchBattlelog(tag, token);

		// The newest eligible battle is the only candidate: a tick posts at most one. Anything
		// between the cursor and it is skipped by design, not retried later.
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

		// Advance the cursor only after a successful post: at-least-once delivery of the battle this
		// tick selected (not of every battle played). If the webhook succeeds but this put throws, the
		// next run re-posts a duplicate rather than drops it.
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

/**
 * Read-only dump of every stored cursor, keyed by tag, for main.ts's debug route. Values stay raw
 * on purpose — interpreting cursors (validation, first-run vs. corrupt) is poll()'s job.
 */
async function listCursors(): Promise<Record<string, unknown>> {
	const cursors: Record<string, unknown> = {};

	for await (const entry of kv.list({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;
		cursors[String(tag)] = entry.value;
	}

	return cursors;
}

export { listCursors, poll, POLL_OUTCOMES };
export type { PollOutcome };
