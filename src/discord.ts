import { renderDeckGrid } from "@/deck-image.ts";
import { ERROR_BODY_CHARS, hl, log } from "@/log.ts";
import type { Battle, Card, EvolutionLevel, Player } from "@/schema.ts";

const OUTCOMES = {
	[1]: { result: "Victory", verb: "Won", color: 0x00_c9_50 }, // Green
	[-1]: { result: "Defeat", verb: "Lost", color: 0xe7_00_0b }, // Red
	// No verb: `battleContext` uses this being undefined as the signal to skip the HP-margin line.
	[0]: { result: "Draw", verb: undefined, color: 0xff_df_20 }, // Yellow
} as const;

const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

/** Deep link to a player's RoyaleAPI battle log; the site's URLs carry the tag without its "#". */
const matchHistoryUrl = (tag: string) =>
	`https://royaleapi.com/player/${tag.replace("#", "")}/battles`;

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
} as const satisfies Record<EvolutionLevel, string>;

/** Lowest HP among a player's surviving towers (HP > 0); 0 if none survive or there's no player. */
function weakestSurvivingTowerHp(player: Player | undefined) {
	const alive = [
		player?.kingTowerHitPoints ?? 0,
		...(player?.princessTowersHitPoints ?? []),
	].filter((hp) => hp > 0);

	return alive.length === 0 ? 0 : Math.min(...alive);
}

/**
 * An empty array must fall back the same way as an absent one: `[].join(" · ")` returns `""`, not a
 * nullish value, so `?? "—"` never fires on it.
 */
function formatDeck(cards: Card[] | undefined) {
	if (cards === undefined || cards.length === 0) {
		return "—";
	}

	return cards
		.map(
			(card) => `${card.evolutionLevel ? EVOLUTION_PREFIX[card.evolutionLevel] : ""}${card.name}`
		)
		.join(" · ");
}

/** Trophy progression for a player, e.g. "5,432 → 5,463 (+31)". Dropped on modes without trophies. */
function buildTrophyField(player: Player | undefined, label: string) {
	if (player?.startingTrophies === undefined) {
		return undefined;
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
 * The pair of inline trophy rows for an embed from `subject`'s point of view, so the opponent's
 * embed stays labelled from the opponent's side.
 */
function buildTrophyFields(subject: Player | undefined, other: Player | undefined) {
	return [
		buildTrophyField(subject, "Trophies"),
		buildTrophyField(other, "Opponent Trophies"),
	].filter(Boolean);
}

function buildSupportField(player: Player | undefined, label: string) {
	if (!player?.supportCards.length) {
		return undefined;
	}

	return {
		name: label,
		value: player.supportCards.map((card) => card.name).join(", "),
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
		return undefined;
	}

	return { url: TOWER_TROOP_ART[troop.id] ?? troop.iconUrls.medium };
}

/**
 * The battle-wide bits both message shapes (image embeds and text fallback) share: the outcome, the
 * content block, and a per-side embed-base builder. `embedBase` takes the player whose embed it is,
 * because the "Match History" link must deep-link that side's own battle log, not always the
 * tracked player's.
 */
function battleContext(battle: Battle, me: Player) {
	const opponent = battle.opponent[0];
	const opponentCrowns = opponent?.crowns ?? 0;
	const diff = Math.sign(me.crowns - opponentCrowns) as keyof typeof OUTCOMES;
	const outcome = OUTCOMES[diff];

	// HP margin on decisive games only, measured on the winner's side so it stays positive even
	// when both sides felled a tower (e.g. 2-1).
	const winner = diff === 1 ? me : opponent;
	const margin = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Content doubles as the push-notification text, which bare embeds wouldn't provide.
	const scoreLine = `${me.name}  ${String(me.crowns)} — ${String(opponentCrowns)}  ${opponent?.name ?? "Unknown"}`;
	const content = [`# ${outcome.result}`, `## ${scoreLine}`, margin].filter(Boolean).join("\n");

	const footer = { text: battle.gameMode?.name.replaceAll("_", " ") ?? battle.type };

	const embedBase = (player: Player) => ({
		author: {
			name: "Match History",
			icon_url: ROYALE_API_ICON,
			url: matchHistoryUrl(player.tag),
		},
		title: player.name,
		color: outcome.color,
		footer,
		timestamp: battle.battleTime,
	});

	return { me, opponent, content, embedBase };
}

type BattleContext = ReturnType<typeof battleContext>;

/**
 * Renders both deck grids and packs them with the JSON payload into multipart form data. A missing
 * opponent (defensive; 1v1s always have one) just drops the second side.
 */
async function buildForm({ me, opponent, content, embedBase }: BattleContext) {
	const sides = [
		{ player: me, other: opponent, filename: "my-deck.png" },
		...(opponent === undefined ? [] : [{ player: opponent, other: me, filename: "opp-deck.png" }]),
	];

	// The File and its `attachment://` reference are built together because Discord pairs them by
	// filename and drops the image on a mismatch.
	const parts = await Promise.all(
		sides.map(async ({ player, other, filename }) => ({
			file: new File([await renderDeckGrid(player.cards)], filename, { type: "image/png" }),
			embed: {
				...embedBase(player),
				thumbnail: towerThumbnail(player),
				fields: buildTrophyFields(player, other),
				image: { url: `attachment://${filename}` },
			},
		}))
	);

	const form = new FormData();
	form.append("payload_json", JSON.stringify({ content, embeds: parts.map((part) => part.embed) }));

	for (const [index, { file }] of parts.entries()) {
		form.append(`files[${String(index)}]`, file);
	}

	return form;
}

/**
 * Text-only single embed, used when deck rendering fails so an image problem never drops the
 * notification. Decks and tower troops become text fields.
 */
function buildFallbackMessage({ me, opponent, content, embedBase }: BattleContext) {
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

	return { content, embeds: [{ ...embedBase(me), fields }] };
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
 * Discord rejects outright (see {@link PAYLOAD_REJECTED}) retries once with the text-only fallback
 * instead of failing the whole tick and re-posting the identical oversized request every minute.
 *
 * @throws When Discord still rejects the post after that retry (a 5xx/429, or a non-payload 4xx).
 */
async function notifyBattle(webhookUrl: string, battle: Battle) {
	const me = battle.team[0];

	if (me === undefined) {
		return;
	}

	const ctx = battleContext(battle, me);

	// Built on demand, not up front: the image path is the common case and never sends this, so
	// eagerly formatting both decks into an embed body would be wasted on almost every post.
	const textRequest = (): RequestInit => ({
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(buildFallbackMessage(ctx)),
	});

	// The only state that varies. Whether an image was sent is just `form !== undefined` — no
	// separate flag to keep in sync with it.
	let form: FormData | undefined;

	try {
		form = await buildForm(ctx);
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
			`Discord rejected the deck image (${hl.strong(String(response.status))}), retrying text-only: ${rejected.slice(0, ERROR_BODY_CHARS)}`
		);

		response = await postWebhook(webhookUrl, textRequest());
	}

	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Discord webhook ${String(response.status)}: ${body.slice(0, ERROR_BODY_CHARS)}`
		);
	}

	await response.body?.cancel();
}

export { notifyBattle };
