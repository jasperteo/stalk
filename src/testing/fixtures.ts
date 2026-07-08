/**
 * Shared raw Clash Royale API shapes for tests: plain objects as the API would send them
 * (unnormalized lowercase tags, optional fields absent), pre-validation. Tests spread in only the
 * fields they assert on, and parse through `BattleSchema` where a validated `Battle` is needed.
 */

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
		opponent: [rawPlayer({ tag: "def456", name: "Bob", crowns: 1 })],
		...overrides,
	};
}
