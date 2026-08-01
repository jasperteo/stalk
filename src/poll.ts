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
const POLL_OUTCOMES = ["posted", "seeded", "skipped", "drifted", "failed"] as const;
type PollOutcome = (typeof POLL_OUTCOMES)[number];

/**
 * Polls one target against the cursor `pollAll` read for it this tick. Taking `stored` as an
 * argument rather than fetching it is what lets a tick cost one KV read instead of one per player —
 * see `pollAll`. The value arrives raw and unvalidated, exactly as `listCursors` returns it.
 */
async function poll(target: Target, token: string, stored: unknown): Promise<PollOutcome> {
	const { tag, webhook } = target;

	try {
		const entries = await fetchBattlelog(tag, token);

		// The newest eligible battle is the only candidate: a tick posts at most one. Anything
		// between the cursor and it is skipped by design, not retried later.
		const { battle: latest, drifted } = latestBattle(entries);

		if (latest === undefined) {
			// Drift must not read as a quiet tick: the cursor stays put and the battle retries once the
			// schema catches up, but the tally has to show why nothing posted.
			return drifted ? "drifted" : "skipped";
		}

		const key = lastBattleKey(tag);

		// An absent cursor (first run, or expired) arrives as `undefined`: `listCursors` omits the key
		// entirely rather than yielding a null value. It fails the parse like any other non-cursor, so
		// only a *present* value that fails is corrupt — re-seed like a first run instead of re-posting
		// every tick against a cursor that can never match.
		const cursor = v.safeParse(CursorSchema, stored);
		if (stored !== undefined && !cursor.success) {
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
 * Read-only dump of every stored cursor, keyed by tag. Serves two callers: `pollAll`, which reads
 * the whole set once per tick, and main.ts's debug route. Values stay raw on purpose — interpreting
 * cursors (validation, first-run vs. corrupt) is poll()'s job.
 */
async function listCursors(): Promise<Record<string, unknown>> {
	const cursors: Record<string, unknown> = {};

	for await (const entry of kv.list({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;
		cursors[String(tag)] = entry.value;
	}

	return cursors;
}

/**
 * Polls every target for one cron tick — the tick's entry point, so the KV handle stays private to
 * this module.
 *
 * One `list` for the whole set, rather than a `kv.get` per player: KV reads are the free tier's
 * binding limit (450k/month), and a per-player read at one tick a minute costs ~43.8k of them per
 * player per month — about 88% of the budget at nine players, and over it at eleven. Reading them
 * together makes a tick's read cost flat in the number of targets. Writes are untouched: each
 * player still writes its own `["lastBattle", tag]` key on success, so there is no shared value for
 * concurrent polls to clobber and invariant 2 is unchanged.
 *
 * Taking the snapshot before the fetches rather than after each one is safe: `Deno.cron` does not
 * overlap ticks, and this cron is the only writer.
 *
 * Poll() catches its own errors and resolves "failed" — no rejection path, hence Promise.all over
 * allSettled. One player's failure can't sink the others.
 */
async function pollAll(targets: Target[], token: string): Promise<PollOutcome[]> {
	const cursors = await listCursors();

	return await Promise.all(targets.map((target) => poll(target, token, cursors[target.tag])));
}

export { listCursors, POLL_OUTCOMES, pollAll };
export type { PollOutcome };
