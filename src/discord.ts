/**
 * @module
 *
 * Builds and posts the Discord webhook message for a battle: a content line, then one embed per
 * side with deck grid, trophies, and tower-troop thumbnail.
 */

import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log, truncatedBody } from "@/log.ts";
import type { Battle, Card, Player } from "@/schema.ts";
import { evolutionOf } from "@/schema.ts";

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

const OUTCOMES = {
	victory: { result: "Victory", verb: "Won", color: 0x00_c9_50 }, // Green
	defeat: { result: "Defeat", verb: "Lost", color: 0xe7_00_0b }, // Red
	// No verb: `battleContext` uses this being undefined as the signal to skip the HP-margin line.
	draw: { result: "Draw", verb: undefined, color: 0xff_df_20 }, // Yellow
} as const;

const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

/**
 * Abort the webhook POST after this long; generous because the multipart body carries the deck PNGs
 * stored uncompressed (see `GRID_COMPRESSION`), about 6.6 MiB for the pair of grids a post
 * carries.
 */
const WEBHOOK_TIMEOUT_MS = 15_000;

const SPACER_FIELD = { name: "\u{200B}", value: "\u{200B}" } as const;

/**
 * Suppresses every mention Discord would otherwise parse out of `content`. Absent this field
 * Discord's default is to parse all of them: users, roles, `@everyone`/`@here`. And `content`
 * carries the opponent's display name, which is free text chosen by a stranger the matchmaker
 * picked. This app never intends to mention anyone, so an empty `parse` list costs nothing and
 * stops the ping behavior from depending on an upstream name filter we don't control.
 */
const ALLOWED_MENTIONS = { parse: [] } as const;

// ═════════════════════════════════════════ EMBED FIELDS ══════════════════════════════════════════

/** Deep link to a player's RoyaleAPI battle log; the site's URLs carry the tag without its "#". */
function matchHistoryUrl(tag: string) {
	return `https://royaleapi.com/player/${tag.replace("#", "")}/battles`;
}

/**
 * An empty deck still needs the explicit branch: `[].join(" · ")` returns `""`, not a nullish
 * value, so a `?? "—"` at the call site would never fire on it.
 *
 * @returns The card names joined by `" · "`, or `"—"` when the deck is empty.
 */
function formatDeck(cards: Card[]) {
	if (cards.length === 0) {
		return "—";
	}

	return cards.map((card) => `${evolutionOf(card).prefix}${card.name}`).join(" · ");
}

/**
 * Trophy progression for a player, e.g. "5,432 → 5,463 (+31)".
 *
 * @param label The field's display name, so the same builder serves both the player's row and the
 *   opponent's.
 * @returns The embed field, or `undefined` on modes without trophies. The caller filters it out.
 */
function buildTrophyField(player: Player, label: string) {
	if (player.startingTrophies === undefined) {
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
 *
 * @param subject The player whose embed this is, labelled "Trophies".
 * @param other The other side, labelled "Opponent Trophies". Swapping the two is what flips the
 *   point of view for the opponent's embed.
 */
function buildTrophyFields(subject: Player, other: Player) {
	return [
		buildTrophyField(subject, "Trophies"),
		buildTrophyField(other, "Opponent Trophies"),
	].filter((field) => field !== undefined);
}

/**
 * The player's tower troops as one comma-joined text field. The fallback embed uses it in place of
 * the thumbnail {@link towerThumbnail} would otherwise carry.
 *
 * @param label The field's display name, labelling this side like {@link buildTrophyField} does.
 * @returns The embed field, or `undefined` on modes with no tower troop.
 */
function buildSupportField(player: Player, label: string) {
	if (player.supportCards.length === 0) {
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
const TOWER_TROOP_ART = new Map([
	// Tower Princess
	[159_000_000, "https://liquipedia.net/commons/images/5/54/Clash_Royale_Card_Tower_Princess.png"],
	// Cannoneer
	[159_000_001, "https://liquipedia.net/commons/images/0/06/Clash_Royale_Card_Cannoneer.png"],
	// Dagger Duchess
	[159_000_002, "https://liquipedia.net/commons/images/f/fb/Clash_Royale_Card_Dagger_Duchess.png"],
	// Royal Chef
	[159_000_004, "https://liquipedia.net/commons/images/5/50/Clash_Royale_Card_Royal_Chef.png"],
]);

/** The player's tower troop art as the embed thumbnail; undefined if the mode has none. */
function towerThumbnail(player: Player) {
	const troop = player.supportCards[0];
	if (troop === undefined) {
		return undefined;
	}

	return { url: TOWER_TROOP_ART.get(troop.id) ?? troop.iconUrls.medium };
}

// ════════════════════════════════════════════ MESSAGE ════════════════════════════════════════════

/**
 * The outcome from the tracked player's side.
 *
 * @param mine Crowns the tracked player took.
 * @param theirs Crowns the opponent took.
 * @returns The matching {@link OUTCOMES} entry: result word, verb, and embed color.
 */
function outcomeFor(mine: number, theirs: number) {
	if (mine > theirs) {
		return OUTCOMES.victory;
	}

	if (mine < theirs) {
		return OUTCOMES.defeat;
	}

	return OUTCOMES.draw;
}

/**
 * Lowest HP among a player's surviving towers (HP > 0).
 *
 * @returns The weakest survivor's HP, or `0` when none survive. A total wipe has no margin to
 *   report.
 */
function weakestSurvivingTowerHp(player: Player) {
	const alive = [player.kingTowerHitPoints, ...player.princessTowersHitPoints].filter(
		(hp) => hp > 0
	);

	return alive.length === 0 ? 0 : Math.min(...alive);
}

/**
 * The battle-wide bits both message shapes (image embeds and text fallback) share: the outcome, the
 * content block, and a per-side embed-base builder. `embedBase` takes the player whose embed it is,
 * because the "Match History" link must deep-link that side's own battle log, not always the
 * tracked player's.
 *
 * `battle.team[0]` is always the tracked player: `BattleSchema` types both sides as one-element
 * tuples, and 2v2s are filtered out upstream anyway. So the destructure below needs no guard.
 *
 * @returns Both sides, the shared `content` line, and `embedBase`. That is everything the two
 *   message shapes need in common.
 */
function battleContext(battle: Battle) {
	const [me] = battle.team;
	const [opponent] = battle.opponent;
	const won = me.crowns > opponent.crowns;
	const outcome = outcomeFor(me.crowns, opponent.crowns);

	// HP margin on decisive games only, measured on the winner's side so it stays positive even
	// when both sides felled a tower (e.g. 2-1).
	const winner = won ? me : opponent;
	const margin = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Content doubles as the push-notification text, which bare embeds wouldn't provide.
	const scoreLine = `${me.name}  ${String(me.crowns)} — ${String(opponent.crowns)}  ${opponent.name}`;
	const content = [`# ${outcome.result}`, `## ${scoreLine}`, margin]
		.filter((line) => line !== undefined)
		.join("\n");

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

/** `inline` is set only on the trophy rows, the one pair meant to sit side by side. */
type EmbedField = { name: string; value: string; inline?: boolean };

/**
 * The embed as this module holds it, before serialization. Discord's own embed object allows far
 * more; narrowing it to the two shapes actually built is what turns {@link payloadJson} into a
 * checked contract instead of a `JSON.stringify` that takes anything. `thumbnail` and `image` are
 * optional because only {@link buildForm}'s embed carries them; {@link buildFallbackMessage} folds
 * the same information into `fields`.
 *
 * `timestamp` is a `Temporal.Instant`, not the ISO string Discord receives. It becomes that string
 * inside {@link payloadJson}, where `JSON.stringify` reaches `Temporal.Instant.prototype.toJSON`.
 */
type Embed = {
	author: { name: string; icon_url: string; url: string };
	title: string;
	color: number;
	footer: { text: string };
	timestamp: Temporal.Instant;
	fields: EmbedField[];
	thumbnail?: { url: string };
	image?: { url: string };
};

/**
 * The one place a webhook body is serialized, so no payload shape can forget
 * {@link ALLOWED_MENTIONS}. Both the multipart `payload_json` part and the text-only fallback go
 * through here. Adding the field per call site instead would leave a third shape unprotected, and
 * silently so, by default.
 */
function payloadJson(message: { content: string; embeds: Embed[] }) {
	return JSON.stringify({ ...message, allowed_mentions: ALLOWED_MENTIONS });
}

/**
 * Renders both deck grids and packs them with the JSON payload into multipart form data.
 *
 * @throws When a deck fails to render. {@link tryBuildForm} catches this to reach the text-only
 *   fallback, so an image problem costs the post its pictures, never the notification.
 */
async function buildForm({ me, opponent, content, embedBase }: BattleContext) {
	const sides = [
		{ player: me, other: opponent, filename: "my-deck.png" },
		{ player: opponent, other: me, filename: "opp-deck.png" },
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
	form.append("payload_json", payloadJson({ content, embeds: parts.map((part) => part.embed) }));

	for (const [index, { file }] of parts.entries()) {
		form.append(`files[${String(index)}]`, file);
	}

	return form;
}

/**
 * {@link buildForm}, with a render failure turned into an absent form rather than a throw. That is
 * what lets {@link notifyBattle} hold the form in a `const` and treat "no images" as one state,
 * whatever produced it.
 *
 * @returns The multipart body, or `undefined` when a deck failed to render. The caller posts
 *   text-only either way, so the two causes need no distinguishing beyond this log line.
 */
async function tryBuildForm(ctx: BattleContext) {
	try {
		return await buildForm(ctx);
	} catch (error) {
		log.error("Deck image render failed, posting text-only fallback:", error);
		return undefined;
	}
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
		{ name: "Opponent Deck", value: formatDeck(opponent.cards) },
		buildSupportField(opponent, "Opponent Tower Troop"),
	].filter((field) => field !== undefined);

	return { content, embeds: [{ ...embedBase(me), fields }] };
}

// ════════════════════════════════════════════ WEBHOOK ════════════════════════════════════════════

/**
 * Statuses where Discord rejected the payload itself, so the message was definitely not delivered
 * and retrying with the smaller text-only body cannot double-post. A 5xx or 429 may have been
 * accepted before the response failed, so those still throw and let the cron tick retry the whole
 * post instead.
 *
 * 400 is overloaded. Discord returns it for an oversized attachment _and_ for a malformed embed
 * body. Only the first is fixed by dropping the image, so a malformed-embed 400 costs one extra
 * doomed POST before the throw. Worth it to keep oversized payloads self-healing.
 */
const PAYLOAD_REJECTED = new Set([400, 413]);

/** `method` and `signal` are always {@link postWebhook}'s, never a caller's, to set. */
type WebhookRequest = Omit<RequestInit, "method" | "signal">;

/**
 * POSTs one prepared request to the webhook.
 *
 * @returns The response unjudged. The caller decides what a non-ok status means, since only it
 *   knows whether a retry is still available.
 */
async function postWebhook(webhookUrl: string, request: WebhookRequest) {
	return await fetch(webhookUrl, {
		...request,
		method: "POST",
		signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
	});
}

/**
 * Settles a webhook response that has no retry left behind it: throw on a non-ok status, otherwise
 * drain the body so the connection is released rather than pinned by an unread one. Both of
 * {@link notifyBattle}'s post paths end here, which is what keeps the two from drifting apart.
 *
 * @throws When Discord rejected the post.
 */
async function finishPost(response: Response) {
	if (!response.ok) {
		throw new Error(`Discord webhook ${String(response.status)}: ${await truncatedBody(response)}`);
	}

	await response.body?.cancel();
}

/**
 * Posts a single battle to the webhook.
 *
 * Multipart when the deck images render, otherwise the JSON text fallback. On the multipart path
 * fetch derives the boundary from the FormData body, so there is no manual Content-Type. A payload
 * Discord rejects outright (see {@link PAYLOAD_REJECTED}) retries once with the text-only fallback,
 * instead of failing the whole tick and re-posting the identical oversized request every minute.
 *
 * @throws When Discord still rejects the post after that retry (a 5xx/429, or a non-payload 4xx).
 */
async function notifyBattle(webhookUrl: string, battle: Battle) {
	const ctx = battleContext(battle);

	// `undefined` when the deck render failed. Note this says the images were *built*, not that they
	// were delivered: the payload-rejection path below has a form in hand and still ends up posting
	// text-only.
	const form = await tryBuildForm(ctx);

	if (form !== undefined) {
		const response = await postWebhook(webhookUrl, { body: form });

		// Everything but a rejection of the payload itself is final, success included. A 5xx/429 may
		// already have been accepted, so a retry could double-post; a non-payload 4xx would fail
		// identically. Only the PAYLOAD_REJECTED statuses fall through to the smaller body below, and
		// none of them is a 2xx, so this covers an ok response too.
		if (!PAYLOAD_REJECTED.has(response.status)) {
			await finishPost(response);
			return;
		}

		log.warn(
			`Discord rejected the deck image (${hl.strong(String(response.status))}), retrying text-only: ${await truncatedBody(response)}`
		);
	}

	// Reached when the deck render failed, or when Discord rejected the images. Both want the same
	// text-only body, and neither has a retry left after it. Building it here rather than up front is
	// what keeps `buildFallbackMessage` off the image path, which is the common case.
	await finishPost(
		await postWebhook(webhookUrl, {
			headers: { "Content-Type": "application/json" },
			body: payloadJson(buildFallbackMessage(ctx)),
		})
	);
}

export { notifyBattle };

/**
 * @internal Exported for tests only. The presentation tests assert on a message object directly,
 *   instead of stubbing `fetch` and decoding a multipart body to read one embed field.
 *   `payloadJson` stays private, so no new call site can serialize a body without
 *   {@link ALLOWED_MENTIONS}.
 */
export { battleContext, buildFallbackMessage };
