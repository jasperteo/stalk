import type { Battle, Player } from "@/schema";

const COLOR_WIN = 0x57_f2_87; /* Green */
const COLOR_LOSS = 0xed_42_45; /* Red */
const COLOR_DRAW = 0xfe_e7_5c; /* Yellow */

const SPACER_FIELD = { name: "\u200B", value: "\u200B", inline: false } as const;

const OUTCOMES = {
	[1]: {
		result: "Victory",
		color: COLOR_WIN,
		thumbnail:
			"https://media.discordapp.net/stickers/1519442354766086144.webp?size=320&quality=lossless",
	},
	[-1]: {
		result: "Defeat",
		color: COLOR_LOSS,
		thumbnail:
			"https://media.discordapp.net/stickers/1518800467675578589.webp?size=320&quality=lossless",
	},
	[0]: {
		result: "Draw",
		color: COLOR_DRAW,
		thumbnail:
			"https://media.discordapp.net/stickers/1519078867950764182.webp?size=320&quality=lossless",
	},
};

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

function formatDeck(cards: Player["cards"] | undefined) {
	return cards?.map((card) => card.name).join(" · ") ?? "—";
}

function buildSupportField(player: Player | undefined, label: string) {
	if (!player?.supportCards?.length) return;
	return {
		name: label,
		value: player.supportCards.map((card) => card.name).join(", "),
		inline: true,
	};
}

function buildEmbed(battle: Battle, me: Player) {
	const myCrowns = totalCrowns(battle.team);
	const opponentCrowns = totalCrowns(battle.opponent);
	const diff = Math.sign(myCrowns - opponentCrowns);

	const { result, color, thumbnail } = OUTCOMES[diff as 1 | -1 | 0];

	const opponent = battle.opponent[0];

	const fields = [
		{ name: "Deck", value: formatDeck(me.cards), inline: true },
		buildSupportField(me, "Tower Troop"),
		me.supportCards?.length ? SPACER_FIELD : undefined,
		{ name: "Opponent Deck", value: formatDeck(opponent?.cards), inline: true },
		buildSupportField(opponent, "Opponent Tower Troop"),
	].filter(Boolean);

	const embed = {
		title: `${result} · ${me.name} ${String(myCrowns)}-${String(opponentCrowns)} ${opponent?.name ?? "Unknown"}`,
		color,
		thumbnail: { url: thumbnail },
		fields,
		footer: { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type },
		timestamp: battle.battleTime,
	};

	return embed;
}

/** Posts a single battle to the webhook as an embed. */
export async function notifyBattle(webhookUrl: string, playerTag: string, battle: Battle) {
	const me = findTrackedPlayer(battle.team, playerTag);
	if (me === undefined) return;

	const embed = buildEmbed(battle, me);
	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ embeds: [embed] }),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Discord webhook ${String(response.status)}: ${body.slice(0, 200)}`);
	}
}
