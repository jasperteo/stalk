import type { Battle, Card, Player } from "@/schema";

const COLOR_WIN = 0x57_f2_87; /* Green */
const COLOR_LOSS = 0xed_42_45; /* Red */
const COLOR_DRAW = 0xfe_e7_5c; /* Yellow */

const SPACER_FIELD = { name: "\u200B", value: "\u200B" } as const;

const OUTCOMES = {
	[1]: {
		result: "Victory",
		verb: "Won",
		color: COLOR_WIN,
		thumbnail: "https://media.discordapp.net/stickers/1519442354766086144.webp?size=320",
	},
	[-1]: {
		result: "Defeat",
		verb: "Lost",
		color: COLOR_LOSS,
		thumbnail: "https://media.discordapp.net/stickers/1518800467675578589.webp?size=320",
	},
	[0]: {
		result: "Draw",
		// A draw has no margin line, so no verb — `buildMessage` keys the HP line off this being absent.
		verb: undefined,
		color: COLOR_DRAW,
		thumbnail: "https://media.discordapp.net/stickers/1519078867950764182.webp?size=320",
	},
} as const;

/** Evolutions render as "Evo <name>", Heroes as "Hero <name>"; ordinary cards stay bare. */
const EVOLUTION_PREFIX = {
	1: "Evo ",
	2: "Hero ",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, string>;

function normalizeTag(tag: string) {
	const normalized = tag.replace(/^#/, "").toUpperCase();
	return normalized;
}

function findTrackedPlayer(team: Player[], playerTag: string) {
	const normalized = normalizeTag(playerTag);
	const trackedPlayer = team.find((player) => normalizeTag(player.tag) === normalized) ?? team[0];
	return trackedPlayer;
}

function totalCrowns(players: Player[]) {
	let total = 0;
	for (const player of players) total += player.crowns;
	return total;
}

/**
 * Lowest HP among a side's _surviving_ towers (HP > 0) — the one the opponent was closest to taking
 * next. Destroyed towers (backfilled to 0) are skipped: they've already fallen and are no longer
 * the "next crown". Returns 0 if no towers survive (all destroyed, or empty side).
 */
function weakestSurvivingTowerHp(players: Player[]) {
	let min = Infinity;
	for (const player of players) {
		if (player.kingTowerHitPoints > 0) {
			min = Math.min(min, player.kingTowerHitPoints);
		}
		for (const hp of player.princessTowersHitPoints) {
			if (hp > 0) {
				min = Math.min(min, hp);
			}
		}
	}
	return min === Infinity ? 0 : min;
}

function formatCardName(card: Card) {
	const prefix = card.evolutionLevel ? EVOLUTION_PREFIX[card.evolutionLevel] : "";
	return `${prefix}${card.name}`;
}

function formatDeck(cards: Card[] | undefined) {
	return cards?.map((card) => formatCardName(card)).join(" · ") ?? "—";
}

function buildSupportField(player: Player | undefined, label: string) {
	if (!player?.supportCards.length) return;
	return {
		name: label,
		value: player.supportCards.map((card) => card.name).join(", "),
	};
}

function buildMessage(battle: Battle, me: Player) {
	const myCrowns = totalCrowns(battle.team);
	const opponentCrowns = totalCrowns(battle.opponent);
	const diff = Math.sign(myCrowns - opponentCrowns);

	const { result, verb, color, thumbnail } = OUTCOMES[diff as 1 | -1 | 0];

	const opponent = battle.opponent[0];

	const fields = [
		{ name: "Deck", value: formatDeck(me.cards) },
		buildSupportField(me, "Tower Troop"),
		SPACER_FIELD,
		{ name: "Opponent Deck", value: formatDeck(opponent?.cards) },
		buildSupportField(opponent, "Opponent Tower Troop"),
	].filter(Boolean);

	const embed = {
		title: `${me.name} ${String(myCrowns)}-${String(opponentCrowns)} ${opponent?.name ?? "Unknown"}`,
		color,
		thumbnail: { url: thumbnail },
		fields,
		footer: { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type },
		timestamp: battle.battleTime,
	};

	// Content (above the embed): the result as a header, plus a weakest-tower HP margin on decisive
	// games. A draw has no verb, so it shows the result alone and never computes HP. The margin is
	// the weakest surviving tower on the winning side — the tower the loser was closest to taking
	// next. Using the winning side avoids "0hp" when both sides have a destroyed tower (e.g. 2-1).
	const winningSide = diff === 1 ? battle.team : battle.opponent;
	const margin = verb
		? `\n${verb} by ${weakestSurvivingTowerHp(winningSide).toLocaleString()}hp`
		: "";
	const content = `# ${result}${margin}`;

	return { content, embeds: [embed] };
}

/** Posts a single battle to the webhook: result in the content, matchup details in the embed. */
export async function notifyBattle(webhookUrl: string, playerTag: string, battle: Battle) {
	const me = findTrackedPlayer(battle.team, playerTag);
	if (me === undefined) return;

	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildMessage(battle, me)),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Discord webhook ${String(response.status)}: ${body.slice(0, 200)}`);
	}
}
