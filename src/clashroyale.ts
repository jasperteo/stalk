import * as v from "@valibot/valibot";

import { log } from "@/log.ts";
import { BattleSchema, EligibleBattleTimeSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";

/**
 * RoyaleAPI proxy: Deno Deploy has no static egress IP to whitelist on the CR token, so requests
 * route through the proxy and its fixed IP is whitelisted instead.
 */
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/**
 * Aborts the battle-log request after this long — an unbounded hang would stall the cron tick
 * forever.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Fetches a player's raw battle log entries. Schema validation is deferred to `latestBattle`. */
async function fetchBattlelog(playerTag: string, token: string): Promise<unknown[]> {
	const url = `${PROXY_BASE}/players/${encodeURIComponent(playerTag)}/battlelog`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});

	if (!response.ok) {
		const body = await response.text();

		throw new Error(
			`Clash Royale API ${String(response.status)} for ${playerTag}: ${body.slice(0, 200)}`
		);
	}

	return v.parse(v.array(v.unknown()), await response.json());
}

/**
 * Picks the newest battle by timestamp first and validates only that one entry.
 *
 * @returns The newest eligible (1v1) battle, fully validated, or `undefined` if none qualify.
 */
function latestBattle(entries: unknown[]): Battle | undefined {
	let newest: unknown;
	let newestTime = "";

	for (const entry of entries) {
		const battleTime = v.parse(EligibleBattleTimeSchema, entry);

		if (battleTime > newestTime) {
			newest = entry;
			newestTime = battleTime;
		}
	}

	const result = v.safeParse(BattleSchema, newest);

	if (result.success) {
		return result.output;
	}

	// A defined `newest` failing here means the API's shape drifted, not just "no new battles".
	if (newest !== undefined) {
		log.warn("Newest eligible battle failed schema validation:", v.flatten(result.issues));
	}

	return undefined;
}

export { fetchBattlelog, latestBattle };
