import type { Battle, Card, Player } from "@/schema.ts";

/** Green */
const COLOR_WIN = 0x46_a7_58;
/** Red */
const COLOR_LOSS = 0xe5_48_4d;
/** Yellow */
const COLOR_DRAW = 0xff_e6_29;

const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

const SPACER_FIELD = { name: "\u200B", value: "\u200B" } as const;

const OUTCOMES = {
	[1]: {
		result: "Victory",
		verb: "Won",
		color: COLOR_WIN,
		thumbnail: "https://cdn.discordapp.com/stickers/1521984131737583717.png?size=512",
	},
	[-1]: {
		result: "Defeat",
		verb: "Lost",
		color: COLOR_LOSS,
		thumbnail: "https://cdn.discordapp.com/stickers/1522517572539514940.png?size=512",
	},
	[0]: {
		result: "Draw",
		/**
		 * A draw has no margin line, so no verb — `buildMessage` keys the HP line off this being
		 * absent.
		 */
		verb: undefined,
		color: COLOR_DRAW,
		thumbnail: "https://cdn.discordapp.com/stickers/1521984288466407554.png?size=512",
	},
} as const;

/** Evolutions render as "Evo <name>", Heroes as "Hero <name>"; ordinary cards stay bare. */
const EVOLUTION_PREFIX = {
	1: "Evo ",
	2: "Hero ",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, string>;

/** Both tags arrive schema-normalized to canonical "#UPPERCASE" form, so plain equality works. */
function findTrackedPlayer(team: Player[], playerTag: string) {
	return team.find((player) => player.tag === playerTag) ?? team[0];
}

function totalCrowns(players: Player[]) {
	let total = 0;

	for (const player of players) {
		total += player.crowns;
	}

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

/**
 * Trophy progression for a player, e.g. "5,432 → 5,463 (+31)". Absent on modes without trophies
 * (`startingTrophies` undefined), so the field is dropped entirely. Trophies after the match are
 * `startingTrophies + trophyChange`; a missing `trophyChange` counts as 0.
 */
function buildTrophyField(player: Player | undefined, label: string) {
	if (player?.startingTrophies === undefined) {
		return;
	}

	const change = player.trophyChange ?? 0;
	const after = player.startingTrophies + change;
	const sign = change > 0 ? "+" : "";

	return {
		name: label,
		value: `${player.startingTrophies.toLocaleString()} → ${after.toLocaleString()} (${sign}${change.toLocaleString()})`,
		inline: true,
	};
}

function buildSupportField(player: Player | undefined, label: string) {
	if (!player?.supportCards.length) {
		return;
	}

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

	// Trophy rows only exist in trophy modes; the spacer below them is dropped too when they're
	// absent, so non-trophy matches don't open with a dangling empty row.
	const trophyFields = [
		buildTrophyField(me, "Trophies"),
		buildTrophyField(opponent, "Opponent Trophies"),
	].filter(Boolean);

	const fields = [
		...trophyFields,
		...(trophyFields.length > 0 ? [SPACER_FIELD] : []),
		{ name: "Deck", value: formatDeck(me.cards) },
		buildSupportField(me, "Tower Troop"),
		SPACER_FIELD,
		{ name: "Opponent Deck", value: formatDeck(opponent?.cards) },
		buildSupportField(opponent, "Opponent Tower Troop"),
	].filter(Boolean);

	// Weakest-tower HP margin on decisive games, shown as the embed description under the score. A
	// draw has no verb, so it gets no description (undefined drops the key) and never computes HP.
	// The margin is the weakest surviving tower on the winning side — the tower the loser was closest
	// to taking next. Using the winning side avoids "0hp" when both sides felled a tower (e.g. 2-1).
	const winningSide = diff === 1 ? battle.team : battle.opponent;
	const description = verb
		? `${verb} by ${weakestSurvivingTowerHp(winningSide).toLocaleString()}hp`
		: undefined;

	const embed = {
		author: {
			name: "Match History",
			icon_url: ROYALE_API_ICON,
			// The royaleapi.com profile path uses the tag without its leading "#".
			url: `https://royaleapi.com/player/${me.tag.replace("#", "")}/battles`,
		},
		title: `${me.name} ${String(myCrowns)}-${String(opponentCrowns)} ${opponent?.name ?? "Unknown"}`,
		description,
		color,
		thumbnail: { url: thumbnail },
		fields,
		footer: { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type },
		timestamp: battle.battleTime,
	};

	// Content (above the embed) is just the result header — it doubles as the push-notification text,
	// which a bare embed wouldn't provide. The HP margin lives in the embed description above.
	const content = `# ${result}`;

	return { content, embeds: [embed] };
}

/** Posts a single battle to the webhook: result in the content, matchup details in the embed. */
async function notifyBattle(webhookUrl: string, playerTag: string, battle: Battle) {
	const me = findTrackedPlayer(battle.team, playerTag);

	if (me === undefined) {
		return;
	}

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

export { notifyBattle };
