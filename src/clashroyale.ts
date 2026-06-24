import * as v from "valibot";

import { BattleSchema } from "@/schema";

// RoyaleAPI proxy: gives Workers a stable outbound IP to whitelist on the token.
const PROXY_BASE = "https://proxy.royaleapi.dev/v1";

/**
 * Fetches a player's battle log through the RoyaleAPI proxy and returns the battles that pass
 * validation. Unusual battle types that don't match the schema are skipped rather than failing the
 * whole run.
 */
export async function fetchBattlelog(playerTag: string, token: string) {
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
		throw new Error(`Clash Royale API ${response.status} for ${playerTag}: ${body.slice(0, 200)}`);
	}

	const json = await response.json();
	const entries = v.parse(v.array(v.unknown()), json);

	const battles = entries.flatMap((entry) => {
		const result = v.safeParse(BattleSchema, entry);
		return result.success ? [result.output] : [];
	});

	return battles;
}
