/**
 * @module
 *
 * Fetches a player's battle log from the Clash Royale API, through the RoyaleAPI proxy, and picks the
 * newest 1v1 out of it.
 */

import * as v from "valibot";

import { log, truncatedBody } from "@/log.ts";
import type { Battle } from "@/schema.ts";
import { BattleSchema, isEligibleBattle } from "@/schema.ts";

/**
 * The RoyaleAPI proxy, which forwards `/v1/...` requests to the official Clash Royale API. A Clash
 * Royale API token only works from the IP addresses it was created for, and Deno Deploy has no
 * fixed outbound IP to register. The proxy sends every request from its own published IP, so the
 * token is created for that IP instead.
 */
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/**
 * How long the battle-log request may run before it aborts. A hung request would hold the whole
 * tick open, and Deno Deploy skips a scheduled cron run while the previous run is still going.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The battle log as fetched: an array whose entries stay unvalidated until {@link latestBattle}. The
 * array check still matters. An ok response whose body is a JSON object fails here with a
 * `ValiError`, which `poll.ts` reports as `failed`, instead of reaching `latestBattle` and failing
 * on `.find`.
 */
const BattleLogSchema = v.array(v.unknown());
type BattleLog = v.InferOutput<typeof BattleLogSchema>;

/**
 * Fetches a player's battle log. The entries stay unvalidated, because {@link latestBattle} only
 * needs to validate one of them.
 *
 * @param playerTag A canonical tag, `#` included. It is URL-encoded into the path, so `#` becomes
 *   `%23`.
 * @param token The Clash Royale API token, sent as a bearer token.
 * @returns The raw entries in the API's order, newest first. A log holds a player's most recent
 *   battles, around 30 of them.
 * @throws When the response is not ok, with the status, the tag and the start of the body in the
 *   message. Also when the body is not an array (a `ValiError`), and when the request times out.
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

/**
 * The result of {@link latestBattle}. `battle` is the newest eligible battle, fully validated, or
 * `undefined` when there is none to post. `drifted` gives the reason for `undefined`: `false` when
 * the log had no eligible entry, `true` when the newest eligible entry failed full validation.
 */
type BattleSelection = { battle: Battle | undefined; drifted: boolean };

/**
 * Picks the newest 1v1 in a battle log and fully validates only that entry. A tick posts at most
 * one battle per player, so any older battles played since the last tick are never posted.
 *
 * The API returns the log newest first. Supercell does not document that order, but every live log
 * checked follows it, so the first eligible entry is taken as the newest without comparing
 * timestamps. If the order ever changed, this would pick an older battle. `poll.ts` catches the
 * case where that battle predates the stored lastBattle, but not one that is merely older than the
 * true newest. 2v2s and Duels at the head of the log are skipped, so the scan reaches the first 1v1
 * wherever it sits.
 *
 * @returns The selected battle. When the selected entry fails full validation, `battle` is
 *   `undefined` and `drifted` is `true`: the API's shape has moved away from {@link BattleSchema}.
 *   The warning logged here carries the flattened issues, which show what to change in the schema.
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
