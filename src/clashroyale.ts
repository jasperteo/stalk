import * as v from "valibot";

import { BattleSchema, type Battle } from "@/schema";

// RoyaleAPI proxy: gives Workers a stable outbound IP to whitelist on the token.
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/** Fetches a player's raw battle log entries. Schema validation is deferred to `latestBattle`. */
export async function fetchBattlelog(playerTag: string, token: string): Promise<unknown[]> {
	// encodeURIComponent turns the leading "#" into "%23".
	const url = `${PROXY_BASE}/players/${encodeURIComponent(playerTag)}/battlelog`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
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
 * Reuses BattleSchema's own battleTime rule (defined once there) and drops every other key, so we
 * can order entries without paying for full battle validation. battleTime normalizes to standard
 * ISO 8601, which is fixed-width and zero-padded, so string order matches chronological order.
 */
const BattleTimeSchema = v.pick(BattleSchema, ["battleTime"]);

function rawBattleTime(entry: unknown): string {
	const result = v.safeParse(BattleTimeSchema, entry);
	return result.success ? result.output.battleTime : "";
}

/**
 * Returns the newest battle entry, fully validated (or undefined if the log is empty or that entry
 * fails the schema). Picks the newest by cheap timestamp comparison and runs `BattleSchema` on just
 * that one, so per-target CPU stays flat as the number of tracked players grows.
 */
export function latestBattle(entries: unknown[]): Battle | undefined {
	let newest: unknown;
	let newestTime = "";
	for (const entry of entries) {
		const battleTime = rawBattleTime(entry);
		if (battleTime > newestTime) {
			newest = entry;
			newestTime = battleTime;
		}
	}

	const result = v.safeParse(BattleSchema, newest);
	return result.success ? result.output : undefined;
}
