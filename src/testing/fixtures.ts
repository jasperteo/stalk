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
		id: 26_000_000,
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

/**
 * A battle that passes the cheap eligibility check but fails full `BattleSchema` validation — the
 * API-schema-drift case, which `latestBattle` reports and `poll` surfaces as the "drifted" outcome.
 * A non-URL `iconUrls.medium` is the drift: eligibility only reads `type`/`battleTime`, so this
 * entry still wins selection and only then fails.
 */
function driftedBattle(overrides: Record<string, unknown> = {}) {
	return rawBattle({
		team: [rawPlayer({ cards: [rawCard({ iconUrls: { medium: "not-a-url" } })] })],
		...overrides,
	});
}

export { BOB, driftedBattle, rawBattle, rawCard, rawPlayer, WEBHOOK };
