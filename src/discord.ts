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

/**
 * Deck-grid attachment filenames, shared between the embeds' `attachment://` refs and the uploaded
 * `File` names — Discord matches them by string, so a mismatch silently drops the image.
 */
const MY_DECK_FILENAME = "my-deck.png";
const OPPONENT_DECK_FILENAME = "opp-deck.png";

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
 * Everything both message shapes (image embeds and text fallback) derive from the battle: outcome
 * (colour/verb/sticker), score title, HP-margin description, trophy fields, and footer.
 */
function battleContext(battle: Battle, me: Player) {
	const opponent = battle.opponent[0];
	const myCrowns = me.crowns;
	const opponentCrowns = opponent?.crowns ?? 0;
	const diff = Math.sign(myCrowns - opponentCrowns);

	const outcome = OUTCOMES[diff as 1 | -1 | 0];

	// Weakest-tower HP margin on decisive games, shown as the embed description under the score. A
	// draw has no verb, so it gets no description (undefined drops the key) and never computes HP.
	// The margin is the weakest surviving tower on the winner's side — the tower the loser was
	// closest to taking next. Using the winner avoids "0hp" when both sides felled a tower (e.g.
	// 2-1).
	const winner = diff === 1 ? me : opponent;
	const description = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Trophy rows only exist in trophy modes; consumers drop their spacing too when absent.
	const trophyFields = [
		buildTrophyField(me, "Trophies"),
		buildTrophyField(opponent, "Opponent Trophies"),
	].filter(Boolean);

	return {
		opponent,
		outcome,
		title: `${me.name} ${String(myCrowns)}-${String(opponentCrowns)} ${opponent?.name ?? "Unknown"}`,
		description,
		trophyFields,
		footer: { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type },
		// Content (above the embeds) is just the result header — it doubles as the
		// push-notification text, which bare embeds wouldn't provide.
		content: `# ${outcome.result}`,
	};
}

/**
 * The image-rich message: one embed per side. Embed 1 carries the match info (score, HP margin,
 * trophies) plus the tracked player's deck grid and tower-troop thumbnail; embed 2 mirrors the
 * branding for the opponent's deck. Footer and timestamp sit on whichever embed renders last.
 * `attachment://` URLs refer to the files `buildForm` uploads alongside this payload.
 */
function buildMessage(battle: Battle, me: Player) {
	const { opponent, outcome, title, description, trophyFields, footer, content } = battleContext(
		battle,
		me
	);

	const myEmbed = {
		author: buildAuthor(me.tag),
		title,
		description,
		color: outcome.color,
		thumbnail: towerThumbnail(me),
		fields: trophyFields,
		image: { url: `attachment://${MY_DECK_FILENAME}` },
	};

	// buildForm renders a deck grid exactly when the opponent exists (any render failure falls back
	// to the text message instead), so opponent presence alone decides the second embed.
	const opponentEmbed =
		opponent === undefined
			? undefined
			: {
					author: buildAuthor(opponent.tag),
					title: opponent.name,
					color: outcome.color,
					thumbnail: towerThumbnail(opponent),
					image: { url: `attachment://${OPPONENT_DECK_FILENAME}` },
				};

	const trailer = { footer, timestamp: battle.battleTime };
	const embeds =
		opponentEmbed === undefined
			? [{ ...myEmbed, ...trailer }]
			: [myEmbed, { ...opponentEmbed, ...trailer }];

	return { content, embeds };
}

/**
 * Text-only single embed, used when deck rendering fails (icon CDN outage, decode error) so an
 * image problem never drops the notification. Matches the pre-image layout: decks and tower troops
 * as text fields.
 */
function buildFallbackMessage(battle: Battle, me: Player) {
	const { opponent, outcome, title, description, trophyFields, footer, content } = battleContext(
		battle,
		me
	);

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
		title,
		description,
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
		renderDeckGrid(me.cards),
		opponent === undefined ? undefined : renderDeckGrid(opponent.cards),
	]);

	const form = new FormData();

	form.append("payload_json", JSON.stringify(buildMessage(battle, me)));
	form.append("files[0]", new File([myDeck], MY_DECK_FILENAME, { type: "image/png" }));

	if (opponentDeck !== undefined) {
		form.append(
			"files[1]",
			new File([opponentDeck], OPPONENT_DECK_FILENAME, { type: "image/png" })
		);
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
