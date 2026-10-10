/**
 * @module
 *
 * The polling domain. One tick reads every stored lastBattle value, then polls each target: fetch its
 * battle log, pick the newest 1v1, compare it with the stored value, post it if it is newer, and
 * store its time as the new lastBattle.
 *
 * Delivery rules:
 *
 * - At most one battle posts per player per tick, and it is the newest one. Battles played between
 *   two ticks are skipped, and lastBattle jumps straight to the newest.
 * - lastBattle advances only after the post succeeds. If the post succeeds and the KV write then
 *   fails, the next tick posts the same battle again. A duplicate is preferred over a lost battle.
 * - A player with no stored value is seeded: lastBattle is set to their newest battle without
 *   posting, so adding a player never posts an old battle.
 *
 * This module owns the KV handle and the `["lastBattle", tag]` key space. Nothing else opens KV.
 */

import * as v from "valibot";

import { fetchBattlelog, latestBattle } from "@/clash-royale.ts";
import { notifyBattle } from "@/discord.ts";
import { hl, log } from "@/log.ts";
import type { Target } from "@/schema.ts";
import { LastBattleSchema, serializeLastBattle } from "@/schema.ts";

/**
 * The process's only KV handle. On Deno Deploy, `Deno.openKv()` with no path opens the database
 * assigned to the app; locally it opens a file in Deno's cache directory. It is never closed, since
 * the process exits with the instance.
 */
const kv = await Deno.openKv();

/** The first key part of every lastBattle entry. Keys are `["lastBattle", tag]`, one per player. */
const LAST_BATTLE_PREFIX = "lastBattle";

/**
 * How long a lastBattle entry lives after its last write. Every seed and every post rewrites the
 * entry, which restarts the clock. A player removed from `TARGETS` stops being written, so their
 * entry expires and KV does not keep it forever.
 *
 * The cost: a tracked player who plays nothing for 30 days also loses their entry, and their next
 * battle seeds instead of posting. The TTL is 30 days rather than one month because `Temporal`
 * cannot convert months to milliseconds without a reference date.
 */
const LAST_BATTLE_TTL_MS = Temporal.Duration.from({ days: 30 }).total("milliseconds");

/**
 * The possible results of polling one target, in the order the tick's tally line prints them:
 *
 * - `posted`: a newer battle was posted and lastBattle advanced to it.
 * - `seeded`: there was no usable lastBattle (a first run, an expired entry or a corrupt value), so
 *   lastBattle was set to the newest battle without posting.
 * - `skipped`: nothing to post. The newest battle is the stored one, the log has no 1v1, or the
 *   newest 1v1 is older than the stored one.
 * - `drifted`: the newest 1v1 failed full schema validation. lastBattle stays put, so the battle is
 *   retried every tick until the schema matches the API again.
 * - `failed`: something threw, such as the battle-log fetch, the webhook post, the KV write or the
 *   tick's lastBattle read. lastBattle stays put. If the post had already gone out when the KV
 *   write failed, the next tick posts the battle again.
 */
const POLL_OUTCOMES = ["posted", "seeded", "skipped", "drifted", "failed"] as const;
type PollOutcome = (typeof POLL_OUTCOMES)[number];

type LastBattle = v.InferOutput<typeof LastBattleSchema>;

/**
 * Interprets one raw stored value from {@link listLastBattles}.
 *
 * `undefined` means nothing is stored, either because this is the player's first poll or because
 * the entry expired. Both are normal, so this returns `undefined` without parsing or logging. A
 * value that is present but fails to parse is corrupt. That logs a warning and also returns
 * `undefined`, so the player re-seeds; a value that never parses would otherwise be compared, and
 * fail, on every tick.
 *
 * @param stored The raw value, exactly as {@link listLastBattles} returned it.
 * @param tag Used only in the warning.
 * @returns The stored instant, or `undefined` for both cases above. The caller seeds on either.
 */
function readLastBattle(stored: unknown, tag: string): LastBattle | undefined {
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
 * Polls one target for this tick and reports what happened. See {@link POLL_OUTCOMES} for what each
 * result means.
 *
 * It never rejects. Every error, from the fetch, the post or the KV write, is logged and becomes
 * `failed`, which is what lets {@link pollAll} use `Promise.all`.
 *
 * @param target The player to poll and the webhook to post to.
 * @param token The Clash Royale API token.
 * @param stored This player's raw lastBattle value from the tick's single {@link listLastBattles}
 *   read. It is passed in, not fetched here, so that a tick costs one KV read in total.
 */
async function poll(target: Target, token: string, stored: unknown): Promise<PollOutcome> {
	const { tag, webhook } = target;

	try {
		const { battle, drifted } = latestBattle(await fetchBattlelog(tag, token));

		if (battle === undefined) {
			// Drift gets its own outcome so it does not look like a quiet tick in the tally. lastBattle
			// stays put, and the battle posts once the schema is fixed.
			return drifted ? "drifted" : "skipped";
		}

		const lastSeen = readLastBattle(stored, tag);

		// With no usable lastBattle, seed it without posting. The newest battle may be days old.
		const isFirstRun = lastSeen === undefined;

		if (!isFirstRun) {
			const order = Temporal.Instant.compare(battle.battleTime, lastSeen);

			if (order === 0) {
				return "skipped";
			}

			// Only reachable if the battle log stops arriving newest first (see `latestBattle`).
			// Posting this battle would announce an old match and move lastBattle backwards, after
			// which a battle that already posted could post again. Skip it, and warn, because a
			// silent skip would look the same as a player who isn't playing.
			if (order < 0) {
				log.warn(
					`Newest eligible battle for ${hl.entity(tag)} (${serializeLastBattle(battle.battleTime)}) predates the stored lastBattle (${serializeLastBattle(lastSeen)}); skipping`
				);
				return "skipped";
			}

			await notifyBattle(webhook, battle);
		}

		const newLastBattle = serializeLastBattle(battle.battleTime);

		// The write comes after the post. If the post throws, lastBattle stays put and the next tick
		// retries. If the post succeeds and this write throws, the next tick posts the battle again.
		await kv.set([LAST_BATTLE_PREFIX, tag], newLastBattle, { expireIn: LAST_BATTLE_TTL_MS });

		if (isFirstRun) {
			log.info(`Seeded lastBattle for ${hl.entity(tag)} (first run, no notification sent)`);
			return "seeded";
		}

		log.success(`Posted battle for ${hl.entity(tag)} at ${newLastBattle}`);
		return "posted";
	} catch (error) {
		log.error(`Poll failed for ${hl.entity(tag)}:`, error);
		return "failed";
	}
}

/**
 * Reads every stored lastBattle value in one KV `list` command. The values stay raw;
 * {@link readLastBattle} decides whether each one is usable. {@link pollAll} calls this once per
 * tick, and `main.ts` serves it on `GET /kv/last-battle`.
 *
 * @returns A map from tag to raw stored value. A player with nothing stored has no key in the map,
 *   so `get` returns `undefined` exactly when nothing is stored.
 */
async function listLastBattles() {
	const lastBattles = new Map<string, unknown>();

	for await (const entry of kv.list({ prefix: [LAST_BATTLE_PREFIX] })) {
		const [, tag] = entry.key;

		lastBattles.set(String(tag), entry.value);
	}

	return lastBattles;
}

/**
 * Polls every target for one cron tick. It is the only function `main.ts` calls to poll.
 *
 * All lastBattle values come from one {@link listLastBattles} call, never a `kv.get` per player.
 * Deno Deploy's free tier includes 1,000,000 KV read units a month, where a unit is one command
 * reading up to 4 KiB. A tick every minute is about 43,800 ticks a month, so a `get` per player
 * would spend 43,800 units per player per month and use up the quota at 23 players. The single
 * `list` costs one unit per tick while all entries fit in 4 KiB. Writes stay per player: each poll
 * writes only its own key, so concurrent polls never write the same value.
 *
 * It never rejects. {@link poll} catches its own errors, which is why the fan-out below uses
 * `Promise.all` and not `Promise.allSettled`. The lastBattle read runs before any poll, so its
 * failure is caught here. `main.ts` awaits this function without a `catch` and then logs the tally,
 * so an `await` added outside the `try` below could reject and cost the tick its tally line.
 *
 * The fan-out has no concurrency limit. Polling is light, but every player who posts in the same
 * tick renders two deck grids at once. Measured locally with ten renders at once, peak memory grows
 * by about 4.4 MiB per render on a baseline of about 120 MiB, so about 9 MiB per post. Even at
 * twice that, a 768 MB Deno Deploy instance holds more than 30 posts in one tick. A pool such as
 * `p-map` would cap the concurrency while keeping results in input order.
 *
 * @returns One outcome per target, in the same order as `targets`.
 */
async function pollAll(targets: Target[], token: string): Promise<PollOutcome[]> {
	let lastBattles: Map<string, unknown>;

	try {
		lastBattles = await listLastBattles();
	} catch (error) {
		// Report every target as failed and poll nobody; every lastBattle stays as it was, so the next
		// tick retries. Carrying on with an empty map would treat every player as a first run and seed
		// them past their newest battle without posting it.
		log.error("Reading lastBattle failed; every target failed this tick:", error);
		return targets.map(() => "failed");
	}

	return await Promise.all(
		targets.map((target) => poll(target, token, lastBattles.get(target.tag)))
	);
}

export { listLastBattles, POLL_OUTCOMES, pollAll };
export type { PollOutcome };
