import * as v from "@valibot/valibot";

import { BattleSchema, EligibleBattleTimeSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";

/**
 * RoyaleAPI proxy: Deno Deploy has no static egress IP to whitelist on the CR token, so requests
 * route through the proxy and its fixed IP is whitelisted instead.
 */
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/**
 * Abort the battle-log request after this long. Without it a hung proxy connection never rejects,
 * so the awaiting cron tick stalls forever with nothing logged — a timeout turns that into a normal
 * caught error and the next tick retries.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Fetches a player's raw battle log entries. Schema validation is deferred to `latestBattle`. */
async function fetchBattlelog(playerTag: string, token: string): Promise<unknown[]> {
	// `encodeURIComponent` turns the leading "#" into "%23".
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
 * Returns the newest eligible (1v1) battle entry, fully validated (or undefined if no entry is
 * eligible or the newest one fails the schema). Picks the newest by cheap timestamp comparison and
 * runs `BattleSchema` on just that one, so full validation runs once per log instead of once per
 * entry.
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

	return result.success ? result.output : undefined;
}

export { fetchBattlelog, latestBattle };
