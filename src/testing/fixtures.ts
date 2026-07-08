/**
 * Shared raw Clash Royale API shapes for tests: plain objects as the API would send them
 * (unnormalized lowercase tags, optional fields absent), pre-validation. Tests spread in only the
 * fields they assert on, and parse through `BattleSchema` where a validated `Battle` is needed.
 */

/** A syntactically valid Discord webhook URL for tests that need one. */
export const WEBHOOK = "https://discord.com/api/webhooks/1/aaa";

/** `rawBattle`'s default opponent identity, exported so tests overriding the opponent keep it. */
export const BOB = { tag: "def456", name: "Bob", crowns: 1 };

export function rawCard(overrides: Record<string, unknown> = {}) {
	return {
		name: "Knight",
		iconUrls: { medium: "https://api.clashroyale.com/knight.png" },
		...overrides,
	};
}

export function rawPlayer(overrides: Record<string, unknown> = {}) {
	return {
		tag: "abc123",
		name: "Alice",
		crowns: 2,
		cards: [rawCard()],
		supportCards: [],
		...overrides,
	};
}

export function rawBattle(overrides: Record<string, unknown> = {}) {
	return {
		type: "PvP",
		battleTime: "20240115T143022.000Z",
		team: [rawPlayer()],
		opponent: [rawPlayer(BOB)],
		...overrides,
	};
}
