import { renderDeckGrid } from "@/deck-image.ts";
import type { Battle, Card, Player } from "@/schema.ts";

/** Green */
const COLOR_WIN = 0x00_c9_50;
/** Red */
const COLOR_LOSS = 0xe7_00_0b;
/** Yellow */
const COLOR_DRAW = 0xff_df_20;

const OUTCOMES = {
	[1]: {
		result: "Victory",
		verb: "Won",
		color: COLOR_WIN,
	},
	[-1]: {
		result: "Defeat",
		verb: "Lost",
		color: COLOR_LOSS,
	},
	[0]: {
		result: "Draw",
		/**
		 * A draw has no margin line, so no verb — `battleContext` keys the HP line off this being
		 * absent.
		 */
		verb: undefined,
		color: COLOR_DRAW,
	},
} as const;

const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

const SPACER_FIELD = { name: "\u200B", value: "\u200B" } as const;

/** Evolutions render as "Evo <name>", Heroes as "Hero <name>"; ordinary cards stay bare. */
const EVOLUTION_PREFIX = {
	1: "Evo ",
	2: "Hero ",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, string>;

/**
 * Lowest HP among a player's _surviving_ towers (HP > 0) — the one the opponent was closest to
 * taking next. Destroyed towers (backfilled to 0) are skipped: they've already fallen and are no
 * longer the "next crown". Returns 0 if no towers survive (all destroyed, or no player).
 */
function weakestSurvivingTowerHp(player: Player | undefined) {
	if (player === undefined) {
		return 0;
	}

	let min = Infinity;

	if (player.kingTowerHitPoints > 0) {
		min = Math.min(min, player.kingTowerHitPoints);
	}

	for (const hp of player.princessTowersHitPoints) {
		if (hp > 0) {
			min = Math.min(min, hp);
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

/**
 * The pair of inline trophy rows for an embed from `subject`'s point of view: their own progression
 * labelled "Trophies" and the other player's as "Opponent Trophies". Each side is passed as
 * `(subject, other)`, so the opponent's embed leads with — and correctly labels — the opponent's
 * own trophies rather than reusing the tracked player's labelling. Rows drop out in modes without
 * trophies (`buildTrophyField` returns undefined).
 */
function buildTrophyFields(subject: Player | undefined, other: Player | undefined) {
	return [
		buildTrophyField(subject, "Trophies"),
		buildTrophyField(other, "Opponent Trophies"),
	].filter(Boolean);
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

/** "Match History" author block deep-linking to the player's RoyaleAPI battle log. */
function buildAuthor(tag: string) {
	return {
		name: "Match History",
		icon_url: ROYALE_API_ICON,
		// The royaleapi.com profile path uses the tag without its leading "#".
		url: `https://royaleapi.com/player/${tag.replace("#", "")}/battles`,
	};
}

/** The player's tower troop art as the embed thumbnail; undefined if the mode has none. */
function towerThumbnail(player: Player | undefined) {
	const url = player?.supportCards[0]?.iconUrls.medium;
	return url === undefined ? undefined : { url };
}

/**
 * The battle-wide bits both message shapes (image embeds and text fallback) share: the opponent,
 * the outcome (colour/verb), the content block (result header + crown score + HP margin), and the
 * footer. Trophy rows are built per embed by `buildTrophyFields` (they're perspective-dependent),
 * and the per-side embed titles are the players' names, taken straight from `me`/`opponent`.
 */
function battleContext(battle: Battle, me: Player) {
	const opponent = battle.opponent[0];
	const myCrowns = me.crowns;
	const opponentCrowns = opponent?.crowns ?? 0;
	const diff = Math.sign(myCrowns - opponentCrowns);

	const outcome = OUTCOMES[diff as 1 | -1 | 0];

	// Weakest-tower HP margin on decisive games, shown as normal text under the crown score. A draw
	// has no verb, so it gets no margin line (undefined drops out of the content) and never computes
	// HP. The margin is the weakest surviving tower on the winner's side — the tower the loser was
	// closest to taking next. Using the winner avoids "0hp" when both sides felled a tower (e.g.
	// 2-1).
	const winner = diff === 1 ? me : opponent;
	const margin = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Content (above the embeds) doubles as the push-notification text, which bare embeds wouldn't
	// provide: the result as an H1, the crown score as an H2 subheader, then the HP margin as plain
	// text. A draw's absent margin simply drops its line.
	const scoreLine = `${me.name}  ${String(myCrowns)} — ${String(opponentCrowns)}  ${opponent?.name ?? "Unknown"}`;
	const content = [`# ${outcome.result}`, `## ${scoreLine}`, margin].filter(Boolean).join("\n");

	return {
		opponent,
		outcome,
		footer: { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type },
		content,
	};
}

/**
 * A rendered deck grid bundled with the `File` to upload and the `attachment://` image reference
 * the embed uses. Discord pairs the two by filename string and silently drops the image on a
 * mismatch — deriving both from one filename here makes that mismatch unrepresentable.
 */
async function renderDeckAttachment(cards: Card[], filename: string) {
	const png = await renderDeckGrid(cards);

	return {
		file: new File([png], filename, { type: "image/png" }),
		image: { url: `attachment://${filename}` },
	};
}

type DeckAttachment = Awaited<ReturnType<typeof renderDeckAttachment>>;

/**
 * The image-rich message: one embed per side, each titled with the player's name and stamped with
 * the same footer + timestamp. Embed 1 carries the tracked player's trophies, deck grid, and
 * tower-troop thumbnail; embed 2 mirrors the branding for the opponent, with the trophy rows built
 * from the opponent's perspective so their own trophies lead and are labelled correctly. The
 * result, crown score, and HP margin live in the message content. Each embed's image reference
 * comes from the same `DeckAttachment` whose file `buildForm` uploads alongside this payload.
 */
function buildMessage(
	battle: Battle,
	me: Player,
	myDeck: DeckAttachment,
	opponentDeck: DeckAttachment | undefined
) {
	const { opponent, outcome, footer, content } = battleContext(battle, me);

	// Both sides share one embed shape; each is built from its own player's perspective, so the
	// trophy rows lead with — and label — that player's own trophies.
	const sideEmbed = (player: Player, deck: DeckAttachment, other: Player | undefined) => ({
		author: buildAuthor(player.tag),
		title: player.name,
		color: outcome.color,
		thumbnail: towerThumbnail(player),
		fields: buildTrophyFields(player, other),
		image: deck.image,
		footer,
		timestamp: battle.battleTime,
	});

	const myEmbed = sideEmbed(me, myDeck, opponent);

	// The second embed exists exactly when the opponent's deck rendered; its image reference and
	// the uploaded file are two halves of the same attachment, so they can't drift apart.
	const opponentEmbed =
		opponent === undefined || opponentDeck === undefined
			? undefined
			: sideEmbed(opponent, opponentDeck, me);

	const embeds = opponentEmbed === undefined ? [myEmbed] : [myEmbed, opponentEmbed];

	return { content, embeds };
}

/**
 * Text-only single embed, used when deck rendering fails (icon CDN outage, decode error) so an
 * image problem never drops the notification. Matches the pre-image layout: decks and tower troops
 * as text fields.
 */
function buildFallbackMessage(battle: Battle, me: Player) {
	const { opponent, outcome, footer, content } = battleContext(battle, me);

	const trophyFields = buildTrophyFields(me, opponent);
	const fields = [
		...trophyFields,
		...(trophyFields.length > 0 ? [SPACER_FIELD] : []),
		{ name: "Deck", value: formatDeck(me.cards) },
		buildSupportField(me, "Tower Troop"),
		SPACER_FIELD,
		{ name: "Opponent Deck", value: formatDeck(opponent?.cards) },
		buildSupportField(opponent, "Opponent Tower Troop"),
	].filter(Boolean);

	const embed = {
		author: buildAuthor(me.tag),
		title: me.name,
		color: outcome.color,
		fields,
		footer,
		timestamp: battle.battleTime,
	};

	return { content, embeds: [embed] };
}

/**
 * Renders both deck grids and packs them with the JSON payload into multipart form data. A missing
 * opponent (defensive; 1v1s always have one) just drops the second embed and file.
 */
async function buildForm(battle: Battle, me: Player) {
	const opponent = battle.opponent[0];
	const [myDeck, opponentDeck] = await Promise.all([
		renderDeckAttachment(me.cards, "my-deck.png"),
		opponent === undefined ? undefined : renderDeckAttachment(opponent.cards, "opp-deck.png"),
	]);

	const form = new FormData();

	form.append("payload_json", JSON.stringify(buildMessage(battle, me, myDeck, opponentDeck)));
	form.append("files[0]", myDeck.file);

	if (opponentDeck !== undefined) {
		form.append("files[1]", opponentDeck.file);
	}

	return form;
}

/**
 * Posts a single battle to the webhook: result in the content, matchup details in the embeds.
 * `battle.team` is the queried player's side, so its sole entry (2v2 is filtered out upstream) is
 * always the tracked player. Multipart when the deck images render (fetch derives the boundary from
 * the FormData body — no manual Content-Type); JSON fallback otherwise.
 */
async function notifyBattle(webhookUrl: string, battle: Battle) {
	const me = battle.team[0];

	if (me === undefined) {
		return;
	}

	let request: RequestInit;

	try {
		request = { method: "POST", body: await buildForm(battle, me) };
	} catch (error) {
		console.error("Deck image render failed, posting text-only fallback:", error);

		request = {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(buildFallbackMessage(battle, me)),
		};
	}

	const response = await fetch(webhookUrl, request);

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Discord webhook ${String(response.status)}: ${body.slice(0, 200)}`);
	}
}

export { notifyBattle };
