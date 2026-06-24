import type { Battle, Player } from "@/schema";

const COLOR_WIN = 0x57_f2_87; /* Green */
const COLOR_LOSS = 0xed_42_45; /* Red */
const COLOR_DRAW = 0xfe_e7_5c; /* Yellow */

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

function buildEmbed(battle: Battle, me: Player) {
	const myCrowns = totalCrowns(battle.team);
	const opponentCrowns = totalCrowns(battle.opponent);
	const opponentName = battle.opponent[0]?.name ?? "Unknown";

	const won = myCrowns > opponentCrowns;
	const lost = myCrowns < opponentCrowns;
	const result = won ? "🏆 Victory" : lost ? "💀 Defeat" : "🤝 Draw";
	const color = won ? COLOR_WIN : lost ? COLOR_LOSS : COLOR_DRAW;

	const fields: { name: string; value: string; inline?: boolean }[] = [
		{ name: "Deck", value: me.cards.map((card) => card.name).join(" · ") || "—" },
	];

	if (me.supportCards && me.supportCards.length > 0) {
		fields.push({
			name: "Tower Troop",
			value: me.supportCards.map((card) => card.name).join(", "),
			inline: true,
		});
	}
	fields.push({ name: "Opponent", value: opponentName, inline: true });

	const embed = {
		title: `${result} ${myCrowns}–${opponentCrowns} · ${me.name}`,
		color,
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
		throw new Error(`Discord webhook ${response.status}: ${body.slice(0, 200)}`);
	}
}
