/**
 * Shared raw Clash Royale API shapes for tests: plain objects as the API would send them
 * (unnormalized lowercase tags, optional fields absent), pre-validation. Tests spread in only the
 * fields they assert on, and parse through `BattleSchema` where a validated `Battle` is needed.
 */

/** A syntactically valid Discord webhook URL for tests that need one. */
const WEBHOOK = "https://discord.com/api/webhooks/1/aaa";

/** `rawBattle`'s default opponent identity, exported so tests overriding the opponent keep it. */
const BOB = { tag: "def456", name: "Bob", crowns: 1 };

function rawCard(overrides: Record<string, unknown> = {}) {
	return {
		name: "Knight",
		iconUrls: { medium: "https://api.clashroyale.com/knight.png" },
		...overrides,
	};
}

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

function rawBattle(overrides: Record<string, unknown> = {}) {
	return {
		type: "PvP",
		battleTime: "20240115T143022.000Z",
		team: [rawPlayer()],
		opponent: [rawPlayer(BOB)],
		...overrides,
	};
}

export { BOB, rawBattle, rawCard, rawPlayer, WEBHOOK };
