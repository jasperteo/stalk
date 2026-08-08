import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
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
		/** No verb: `battleContext` keys the absent HP-margin line off this being undefined. */
		verb: undefined,
		color: COLOR_DRAW,
	},
} as const;

const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

/**
 * Abort the webhook POST after this long; generous because the multipart body carries the deck PNGs
 * stored uncompressed (see `GRID_COMPRESSION`) — about 6.6 MiB for the pair of grids a post
 * carries.
 */
const WEBHOOK_TIMEOUT_MS = 15_000;

const SPACER_FIELD = { name: "\u{200B}", value: "\u{200B}" } as const;

/**
 * Evolutions render as "Evo <name>", Heroes as "Hero <name>"; ordinary cards stay bare. The
 * `satisfies` guard works like `EVOLUTION_SUFFIX` in deck-image.ts: a new schema level fails to
 * compile rather than fall through to a bare name.
 */
const EVOLUTION_PREFIX = {
	1: "Evo ",
	2: "Hero ",
} as const satisfies Record<NonNullable<Card["evolutionLevel"]>, string>;

/**
 * Lowest HP among a player's surviving towers (HP > 0) — the one closest to falling next. Destroyed
 * towers (backfilled to 0) are skipped.
 *
 * @returns 0 when no towers survive, or when there is no player.
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

/**
 * An empty array must fall back the same way as an absent one: `[].join(" · ")` returns `""`, not a
 * nullish value, so `?? "—"` never fires on it — and this is already the text-only fallback path,
 * so Discord's 400 on a zero-length embed field value has nothing further to fall back to.
 */
function formatDeck(cards: Card[] | undefined) {
	if (cards === undefined || cards.length === 0) {
		return "—";
	}

	return cards.map((card) => formatCardName(card)).join(" · ");
}

/**
 * Trophy progression for a player, e.g. "5,432 → 5,463 (+31)". Dropped entirely on modes without
 * trophies (`startingTrophies` undefined). A missing `trophyChange` counts as 0.
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
 * as "Trophies" and the other player's as "Opponent Trophies". Passing each embed its own subject
 * keeps the opponent's embed labelled from the opponent's side.
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
		url: `https://royaleapi.com/player/${tag.replace("#", "")}/battles`,
	};
}

/**
 * Curated art for the tower troops we have art for, overriding the API's own `iconUrls.medium`.
 * Keyed by troop card id; anything else (a newer troop) falls through to the API icon.
 */
const TOWER_TROOP_ART: Record<number, string> = {
	// Tower Princess
	159_000_000: "https://liquipedia.net/commons/images/5/54/Clash_Royale_Card_Tower_Princess.png",
	// Cannoneer
	159_000_001: "https://liquipedia.net/commons/images/0/06/Clash_Royale_Card_Cannoneer.png",
	// Dagger Duchess
	159_000_002: "https://liquipedia.net/commons/images/f/fb/Clash_Royale_Card_Dagger_Duchess.png",
	// Royal Chef
	159_000_004: "https://liquipedia.net/commons/images/5/50/Clash_Royale_Card_Royal_Chef.png",
};

/** The player's tower troop art as the embed thumbnail; undefined if the mode has none. */
function towerThumbnail(player: Player | undefined) {
	const troop = player?.supportCards[0];
	if (troop === undefined) {
		return;
	}

	return { url: TOWER_TROOP_ART[troop.id] ?? troop.iconUrls.medium };
}

/**
 * The battle-wide bits both message shapes (image embeds and text fallback) share: the opponent,
 * the outcome (colour/verb), the content block, and the footer.
 */
function battleContext(battle: Battle, me: Player) {
	const opponent = battle.opponent[0];
	const myCrowns = me.crowns;
	const opponentCrowns = opponent?.crowns ?? 0;
	const diff = Math.sign(myCrowns - opponentCrowns);

	const outcome = OUTCOMES[diff as 1 | -1 | 0];

	// HP margin on decisive games only, measured on the winner's side so it stays positive even
	// when both sides felled a tower (e.g. 2-1).
	const winner = diff === 1 ? me : opponent;
	const margin = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Content doubles as the push-notification text, which bare embeds wouldn't provide.
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
 * A rendered deck grid bundled with the `File` to upload and the `attachment://` reference the
 * embed uses. Discord pairs the two by filename and drops the image on a mismatch, so both derive
 * from the one `filename` here.
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
 * The image-rich message: one embed per side, each titled with the player's name and carrying that
 * side's trophies, deck grid, and tower-troop thumbnail. The result, crown score, and HP margin
 * live in the message content.
 */
function buildMessage(
	battle: Battle,
	me: Player,
	myDeck: DeckAttachment,
	opponentDeck: DeckAttachment | undefined
) {
	const { opponent, outcome, footer, content } = battleContext(battle, me);

	// One embed shape for both sides, built from each player's own perspective.
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

	// The second embed exists only when the opponent's deck rendered.
	const opponentEmbed =
		opponent === undefined || opponentDeck === undefined
			? undefined
			: sideEmbed(opponent, opponentDeck, me);

	const embeds = opponentEmbed === undefined ? [myEmbed] : [myEmbed, opponentEmbed];

	return { content, embeds };
}

/**
 * Text-only single embed, used when deck rendering fails so an image problem never drops the
 * notification. Decks and tower troops become text fields.
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
 * Statuses where Discord rejected the payload itself, so the message was definitely not delivered
 * and retrying with the smaller text-only body cannot double-post. A 5xx or 429 may have been
 * accepted before the response failed, so those still throw and let the cron tick retry the whole
 * post instead.
 *
 * 400 is overloaded — Discord returns it for an oversized attachment _and_ for a malformed embed
 * body. Only the first is fixed by dropping the image, so a malformed-embed 400 costs one extra
 * doomed POST before the throw. Worth it to keep oversized payloads self-healing.
 */
const PAYLOAD_REJECTED = new Set([400, 413]);

/** POSTs one prepared request to the webhook, returning the response for the caller to judge. */
async function postWebhook(webhookUrl: string, request: RequestInit) {
	return await fetch(webhookUrl, {
		...request,
		signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
	});
}

/**
 * Posts a single battle to the webhook. `battle.team[0]` is always the tracked player (2v2 is
 * filtered out upstream). Multipart when the deck images render — fetch derives the boundary from
 * the FormData body, so no manual Content-Type — otherwise the JSON text fallback. A payload
 * Discord rejects outright (see PAYLOAD_REJECTED) retries once with the text-only fallback instead
 * of failing the whole tick and re-posting the identical oversized request every minute.
 */
async function notifyBattle(webhookUrl: string, battle: Battle) {
	const me = battle.team[0];

	if (me === undefined) {
		return;
	}

	// Built on demand, not up front: the image path is the common case and never sends this, so
	// eagerly formatting both decks into an embed body would be wasted on almost every post.
	const textRequest = (): RequestInit => ({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildFallbackMessage(battle, me)),
	});

	// The one thing that varies; whether an image was sent is `form !== undefined`, so there is no
	// second flag to keep in step with it.
	let form: FormData | undefined;

	try {
		form = await buildForm(battle, me);
	} catch (error) {
		log.error("Deck image render failed, posting text-only fallback:", error);
	}

	let response = await postWebhook(
		webhookUrl,
		form === undefined ? textRequest() : { method: "POST", body: form }
	);

	// Only retry when Discord rejected the image payload itself — see PAYLOAD_REJECTED.
	if (form !== undefined && !response.ok && PAYLOAD_REJECTED.has(response.status)) {
		const rejected = await response.text();

		log.warn(
			`Discord rejected the deck image (${hl.strong(String(response.status))}), retrying text-only: ${rejected.slice(0, 200)}`
		);

		response = await postWebhook(webhookUrl, textRequest());
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Discord webhook ${String(response.status)}: ${body.slice(0, 200)}`);
	}

	await response.body?.cancel();
}

export { notifyBattle };
