import * as v from "valibot";

import { log, truncatedBody } from "@/log.ts";
import type { Battle } from "@/schema.ts";
import { BattleSchema, isEligibleBattle } from "@/schema.ts";

/**
 * RoyaleAPI proxy: Deno Deploy has no static egress IP to whitelist on the CR token, so requests
 * route through the proxy and its fixed IP is whitelisted instead.
 */
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/** Abort the battle-log request after this long, so a hung request can't stall the cron tick. */
const FETCH_TIMEOUT_MS = 10_000;

/** The battle log as fetched: an array whose entries stay unvalidated until {@link latestBattle}. */
const BattleLogSchema = v.array(v.unknown());
type BattleLog = v.InferOutput<typeof BattleLogSchema>;

/**
 * Fetches a player's raw battle-log entries. Schema validation is deferred to {@link latestBattle}.
 *
 * @returns The entries in the API's own order, which is newest-first. That ordering is what
 *   {@link latestBattle} selects on.
 * @throws When the API response isn't ok.
 */
async function fetchBattlelog(playerTag: string, token: string): Promise<BattleLog> {
	const response = await fetch(`${PROXY_BASE}/players/${encodeURIComponent(playerTag)}/battlelog`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		method: "GET",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(
			`Clash Royale API ${String(response.status)} for ${playerTag}: ${await truncatedBody(response)}`
		);
	}

	return v.parse(BattleLogSchema, await response.json());
}

/** What {@link latestBattle} resolved out of a battle log: the battle, or why there isn't one. */
type BattleSelection = { battle: Battle | undefined; drifted: boolean };

/**
 * Picks the newest eligible (1v1) battle and fully validates only that one. A tick posts at most
 * one battle, so matches in between are skipped by design.
 *
 * The log arrives newest-first, so the first eligible entry _is_ the newest and the scan stops
 * there. That ordering is undocumented by Supercell (verified against the live proxy); if it ever
 * changed, we would post an older battle and advance lastBattle past the newer ones. Leading 2v2s
 * and Duels are still walked past, so the assumption only saves scanning the tail.
 *
 * @returns The battle, plus `drifted` when an entry was selected but failed full validation. That
 *   is API schema drift, which the caller surfaces separately from "no new battles".
 */
function latestBattle(entries: BattleLog): BattleSelection {
	const newest = entries.find((entry) => isEligibleBattle(entry));

	if (newest === undefined) {
		return { battle: undefined, drifted: false };
	}

	const result = v.safeParse(BattleSchema, newest);

	if (!result.success) {
		log.warn("Newest eligible battle failed schema validation:", v.flatten(result.issues));

		return { battle: undefined, drifted: true };
	}

	return { battle: result.output, drifted: false };
}

export { fetchBattlelog, latestBattle };
