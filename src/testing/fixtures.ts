/**
 * @module
 *
 * Raw Clash Royale API shapes for tests, as the API would send them before validation: lowercase
 * tags without `#`, optional fields left out. Each factory takes overrides and fills in the rest, so
 * a test states only the fields it cares about. Tests that need a validated `Battle` parse the result
 * through `BattleSchema`.
 */

import { DECK_SIZE } from "@/schema.ts";

/** A well-formed Discord webhook URL. Nothing is ever sent to it. */
const WEBHOOK = "https://discord.com/api/webhooks/1/aaa";

/**
 * The opponent's identity in {@link rawBattle}. Exported so a test that overrides the opponent can
 * spread it in and change one field.
 */
const BOB = { tag: "def456", name: "Bob", crowns: 1 };

/** A raw card; an ordinary Knight unless overridden. */
function rawCard(overrides: Record<string, unknown> = {}) {
	return {
		id: 26_000_000,
		name: "Knight",
		iconUrls: { medium: "https://api.clashroyale.com/knight.png" },
		...overrides,
	};
}

/**
 * A raw player: Alice with 2 crowns and a one-card deck. The trophy and tower HP fields are left
 * out, so the schema's defaults fill in the tower HP.
 */
function rawPlayer(overrides: Record<string, unknown> = {}) {
	return {
		tag: "abc123",
		name: "Alice",
		crowns: 2,
		cards: [rawCard()],
		supportCards: [],
		...overrides,
	};
}

/** A raw 1v1 that Alice wins 2-1 against {@link BOB}, with a compact `battleTime` like the API's. */
function rawBattle(overrides: Record<string, unknown> = {}) {
	return {
		type: "PvP",
		battleTime: "20240115T143022.000Z",
		team: [rawPlayer()],
		opponent: [rawPlayer(BOB)],
		...overrides,
	};
}

/**
 * A battle that passes the eligibility check but fails full `BattleSchema` validation, standing in
 * for a change in the API's shape. `latestBattle` reports it as drift, and `poll` as `drifted`. The
 * broken field is a card's `iconUrls.medium`, which is not a URL. Eligibility counts a player's
 * cards but never looks inside them, so the entry is still selected and only fails afterwards.
 */
function driftedBattle(overrides: Record<string, unknown> = {}) {
	return rawBattle({
		team: [rawPlayer({ cards: [rawCard({ iconUrls: { medium: "not-a-url" } })] })],
		...overrides,
	});
}

/**
 * A Duel entry: one player per side, but `deckCount` whole decks in `team[0].cards`, 16 cards for
 * two decks and 24 for three. The card count is what `isEligibleBattle` rejects it on.
 */
function duelBattle(overrides: Record<string, unknown> = {}, deckCount = 2) {
	return rawBattle({
		team: [
			rawPlayer({
				cards: Array.from({ length: deckCount * DECK_SIZE }, () => rawCard()),
			}),
		],
		...overrides,
	});
}

export { BOB, driftedBattle, duelBattle, rawBattle, rawCard, rawPlayer, WEBHOOK };
