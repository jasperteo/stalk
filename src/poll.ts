import * as v from "valibot";

import { fetchBattlelog, latestBattle } from "@/clash-royale.ts";
import { notifyBattle } from "@/discord.ts";
import { hl, log } from "@/log.ts";
import { LastBattleSchema } from "@/schema.ts";
import type { Target } from "@/schema.ts";

/** One KV handle for the isolate's lifetime; Deno.openKv() opens the Deploy-managed store. */
const kv = await Deno.openKv();

/** LastBattle keys are `["lastBattle", tag]`, namespaced per tag so multiple players share one KV. */
const LAST_BATTLE_PREFIX = "lastBattle";

/**
 * LastBattle entries self-expire so a player removed from TARGETS doesn't leave garbage in KV
 * forever; every posted/seeded battle resets the clock. Fixed at 30 days since Temporal can't total
 * calendar months without a reference point.
 */
const LAST_BATTLE_TTL_MS = Temporal.Duration.from({ days: 30 }).total("milliseconds");

/** Per-target results of a poll, tallied into the cron tick's summary log line, in display order. */
const POLL_OUTCOMES = ["posted", "seeded", "skipped", "drifted", "failed"] as const;
type PollOutcome = (typeof POLL_OUTCOMES)[number];

/**
 * Interprets one raw stored lastBattle value. Absence — `stored` is `undefined`, meaning first run
 * or an expired entry — is never corrupt, so it skips the parse straight to `undefined`;
 * {@link listLastBattles} omits the key entirely rather than yielding null, which is what makes
 * that check exact. A _present_ value that fails to parse is corrupt: log and return `undefined` so
 * the caller re-seeds instead of re-posting every tick against a value that can never match.
 *
 * @param stored The raw KV value, exactly as {@link listLastBattles} read it.
 * @param tag Only for the corrupt-value log line — the value is already in hand, so nothing here
 *   looks anything up by tag.
 * @returns The parsed lastBattle time, or `undefined` for both "no stored value" and "corrupt
 *   value" (already logged) — the caller treats both as first-run.
 */
function readLastBattle(stored: unknown, tag: string): string | undefined {
	if (stored === undefined) {
		return undefined;
	}

	const lastBattle = v.safeParse(LastBattleSchema, stored);

	if (lastBattle.success) {
		return lastBattle.output;
	}

	log.warn(`Corrupt lastBattle value for ${hl.entity(tag)}; re-seeding without posting`);
	return undefined;
}

/**
 * Polls one target against the lastBattle value {@link pollAll} read for it this tick. Taking
 * `stored` as an argument rather than fetching it here is what lets a tick cost one KV read instead
 * of one per player — see {@link pollAll}. Never rejects: every error resolves "failed", which is
 * why `pollAll` uses `Promise.all` rather than `allSettled` — one player's failure can't sink the
 * others.
 *
 * @param stored This tag's raw KV value, still uninterpreted.
 */
async function poll(target: Target, token: string, stored: unknown): Promise<PollOutcome> {
	const { tag, webhook } = target;

	try {
		const { battle, drifted } = latestBattle(await fetchBattlelog(tag, token));

		if (battle === undefined) {
			// Drift must not read as a quiet tick: lastBattle stays put and the battle retries once the
			// schema catches up, but the tally has to show why nothing posted.
			return drifted ? "drifted" : "skipped";
		}

		const lastSeen = readLastBattle(stored, tag);

		if (battle.battleTime === lastSeen) {
			return "skipped";
		}

		// First run (or corrupt lastBattle value): seed without posting a possibly-stale battle.
		const isFirstRun = lastSeen === undefined;

		if (!isFirstRun) {
			await notifyBattle(webhook, battle);
		}

		// Advance lastBattle only after a successful post: at-least-once delivery. If the webhook
		// succeeds but this put throws, the next run re-posts a duplicate rather than drops it.
		await kv.set([LAST_BATTLE_PREFIX, tag], battle.battleTime, { expireIn: LAST_BATTLE_TTL_MS });

		if (isFirstRun) {
			log.info(`Seeded lastBattle for ${hl.entity(tag)} (first run, no notification sent)`);
			return "seeded";
		}

		log.success(`Posted battle for ${hl.entity(tag)} at ${battle.battleTime}`);
		return "posted";
	} catch (error) {
		log.error(`Poll failed for ${hl.entity(tag)}:`, error);
		return "failed";
	}
}

/**
 * Read-only dump of every stored lastBattle value, keyed by tag. Values stay raw and uninterpreted
 * — {@link readLastBattle} is where corrupt-vs-absent gets decided. Used by {@link pollAll} and
 * main.ts's debug route.
 *
 * @returns Tag → raw stored value. A tag with nothing stored is **absent from the record**, not
 *   present-and-nullish, which is what makes {@link readLastBattle}'s `=== undefined` check exact.
 */
async function listLastBattles(): Promise<Record<string, unknown>> {
	const lastBattles: Record<string, unknown> = {};

	for await (const entry of kv.list({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;

		lastBattles[String(tag)] = entry.value;
	}

	return lastBattles;
}

/**
 * Polls every target for one cron tick — the tick's entry point, so the KV handle stays private to
 * this module.
 *
 * One `list` for the whole set, rather than a `kv.get` per player: KV reads are the free tier's
 * binding limit (450k/month), and a per-player read at one tick a minute costs ~43.8k of them per
 * player per month. Reading them together keeps a tick's read cost flat in the target count. Writes
 * are untouched — each player still writes its own key on success, so concurrent polls never share
 * a value.
 *
 * Never rejects, which is what lets main.ts's cron handler await it with no catch of its own and
 * still reach its tally line. {@link poll} contains each target's own errors; the lastBattle read —
 * the one failure that precedes every poll — is contained here. Any `await` added to this function
 * outside that try reintroduces a rejected tick and silently costs the tally.
 *
 * @returns One outcome per target, index-aligned with `targets` (`Promise.all` preserves order).
 */
async function pollAll(targets: Target[], token: string): Promise<PollOutcome[]> {
	let lastBattles: Record<string, unknown>;

	try {
		lastBattles = await listLastBattles();
	} catch (error) {
		// The one error that hits every target at once, so it must not escape as a rejected tick:
		// main.ts would lose both the tally line and this log. Reporting every target "failed" leaves
		// every lastBattle untouched, so the next tick retries. Falling through with an empty map
		// instead would be far worse — every player would read as a first run and get seeded straight
		// past their newest battle, with no post.
		log.error("Reading lastBattle failed; every target failed this tick:", error);
		return targets.map((): PollOutcome => "failed");
	}

	return await Promise.all(targets.map((target) => poll(target, token, lastBattles[target.tag])));
}

export { listLastBattles, POLL_OUTCOMES, pollAll };
export type { PollOutcome };
