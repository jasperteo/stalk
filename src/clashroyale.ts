import * as v from "@valibot/valibot";

import { BattleSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";

/**
 * RoyaleAPI proxy: Deno Deploy has no static egress IP to whitelist on the CR token, so requests
 * route through the proxy and its fixed IP is whitelisted instead.
 */
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/** Fetches a player's raw battle log entries. Schema validation is deferred to `latestBattle`. */
async function fetchBattlelog(playerTag: string, token: string): Promise<unknown[]> {
	// `encodeURIComponent` turns the leading "#" into "%23".
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
 * Cheap ordering-and-eligibility pass: reuses BattleSchema's own battleTime rule (defined once
 * there) and checks the battle is 1v1 (a single `team` entry) without paying for full battle
 * validation. battleTime normalizes to standard ISO 8601, which is fixed-width and zero-padded, so
 * string order matches chronological order. Entries that fail — malformed or team battles (2v2) —
 * fall back to "", which never wins the newest-comparison; ignoring 2v2s here (rather than after
 * selection) means one can't mask an older eligible battle behind it.
 */
const EligibleBattleTimeSchema = v.fallback(
	v.pipe(
		v.object({
			battleTime: BattleSchema.entries.battleTime,
			team: v.pipe(v.array(v.unknown()), v.length(1)),
		}),
		v.transform((battle) => battle.battleTime)
	),
	""
);

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
