/**
 * @module
 *
 * Builds and posts the Discord webhook message for one battle.
 *
 * The message has a `content` block (result, score line, HP margin) and one embed per side. Each
 * embed links to that player's RoyaleAPI battle history and shows their deck as an attached image,
 * their trophy change, and their tower troop as the thumbnail. When a deck grid can't be rendered,
 * or Discord rejects the attachments, the same battle posts as a single text-only embed instead.
 */

import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log, truncatedBody } from "@/log.ts";
import type { Battle, Card, Player } from "@/schema.ts";
import { evolutionOf } from "@/schema.ts";

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The three results from the tracked player's side: the heading word, the verb for the HP margin
 * line, and the embed's side-stripe color (green, red, yellow). A draw has no verb, and
 * {@link battleContext} leaves out the margin line when the verb is `undefined`.
 */
const OUTCOMES = {
	victory: { result: "Victory", verb: "Won", color: 0x00_c9_50 },
	defeat: { result: "Defeat", verb: "Lost", color: 0xe7_00_0b },
	draw: { result: "Draw", verb: undefined, color: 0xff_df_20 },
} as const;

/** RoyaleAPI's logo, shown beside the "Match History" link at the top of each embed. */
const ROYALE_API_ICON = "https://cdn.royaleapi.com/static/img/branding/royaleapi-logo-128.png";

/**
 * How long a webhook POST may run before it aborts. The image post uploads two deck grids stored as
 * uncompressed PNGs, about 3.3 MiB each and 6.6 MiB in total, so this allows more time than the 10
 * seconds given to the battle-log fetch.
 */
const WEBHOOK_TIMEOUT_MS = 15_000;

/**
 * An embed field that renders as blank space. Discord rejects an empty name or value, so both are a
 * zero-width space. The text-only embed uses it to separate the trophy rows from the decks, and one
 * player's deck from the other's.
 */
const SPACER_FIELD = { name: "\u{200B}", value: "\u{200B}" } as const;

/**
 * Turns off every mention Discord would otherwise parse from `content`. Without this field, Discord
 * parses user mentions in webhook messages, and `content` includes the opponent's display name,
 * which is free text chosen by a stranger. The app never means to mention anyone, so an empty
 * `parse` list removes the risk at no cost. {@link payloadJson} adds it to every request body.
 */
const ALLOWED_MENTIONS = { parse: [] } as const;

// ═════════════════════════════════════════ EMBED FIELDS ══════════════════════════════════════════

/** A link to a player's battle history on RoyaleAPI, whose URLs carry the tag without its `#`. */
function matchHistoryUrl(tag: string) {
	return `https://royaleapi.com/player/${tag.replace("#", "")}/battles`;
}

/**
 * A deck as one line of card names, with `Evo ` or `Hero ` before a card played in that form.
 *
 * @returns The names joined by `" · "`, or `"—"` when the deck is empty, as it is in
 *   `All_Random_Princess_Friendly` battles. The empty case needs its own branch because an empty
 *   array joins to `""`, and Discord rejects an embed field with an empty value.
 */
function formatDeck(cards: Card[]) {
	if (cards.length === 0) {
		return "—";
	}

	return cards.map((card) => `${evolutionOf(card).prefix}${card.name}`).join(" · ");
}

/**
 * One trophy row, such as `5,432 → 5,463 (+31)`. A missing `trophyChange` counts as 0. The sign is
 * added only for a gain, since a loss already prints with its minus sign.
 *
 * @param label The field name. The same builder labels both the embed's own player and the other
 *   side.
 * @returns The inline embed field, or `undefined` when the battle carries no `startingTrophies`.
 *   The caller filters that out.
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
 * The pair of trophy rows for one embed, labelled from that embed's point of view.
 *
 * @param subject The player the embed is about, labelled "Trophies".
 * @param other The other side, labelled "Opponent Trophies". The opponent's embed passes the two
 *   players the other way round, so it also reads from its own side.
 * @returns Only the rows that have data. Either can be missing.
 */
function buildTrophyFields(subject: Player, other: Player) {
	return [
		buildTrophyField(subject, "Trophies"),
		buildTrophyField(other, "Opponent Trophies"),
	].filter((field) => field !== undefined);
}

/**
 * A player's tower troop as a text field. Only the text-only embed uses it; the image embeds show
 * the troop as {@link towerThumbnail} instead.
 *
 * @param label The field name, so each side's row can say whose troop it is.
 * @returns The embed field, or `undefined` in modes without a tower troop.
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
 * Art for the tower troops, keyed by card id, used in place of the API's own icon. The API icon is
 * 285×420 with a transparent margin around the card frame, so it looks small in the embed's
 * thumbnail slot. These images are 481×681 and cropped to the frame. A troop missing from this map
 * falls back to the API icon.
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

/**
 * The embed thumbnail for a player's tower troop.
 *
 * @returns The thumbnail object, or `undefined` in modes without a tower troop, which leaves the
 *   embed without one.
 */
function towerThumbnail(player: Player) {
	const troop = player.supportCards[0];
	if (troop === undefined) {
		return undefined;
	}

	return { url: TOWER_TROOP_ART.get(troop.id) ?? troop.iconUrls.medium };
}

// ════════════════════════════════════════════ MESSAGE ════════════════════════════════════════════

/**
 * The result from the tracked player's side, decided by crowns alone.
 *
 * @param mine Crowns the tracked player took.
 * @param theirs Crowns the opponent took.
 * @returns The matching {@link OUTCOMES} entry.
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
 * The HP of a player's weakest tower still standing, which the message reports as the margin.
 *
 * @returns The lowest HP above 0 among the king and princess towers, or `0` when every tower fell.
 */
function weakestSurvivingTowerHp(player: Player) {
	const alive = [player.kingTowerHitPoints, ...player.princessTowersHitPoints].filter(
		(hp) => hp > 0
	);

	return alive.length === 0 ? 0 : Math.min(...alive);
}

/**
 * Everything both message shapes, the image post and the text-only post, share for one battle: the
 * two players, the `content` block, and a builder for the part of an embed that doesn't depend on
 * the shape.
 *
 * `battle.team[0]` is always the tracked player. `BattleSchema` types each side as a one-player
 * tuple, so the destructuring below needs no guard.
 *
 * @returns `me` and `opponent`, the `content` string, and `embedBase(player)`. `embedBase` takes
 *   the player because each embed's "Match History" link goes to that side's own history.
 */
function battleContext(battle: Battle) {
	const [me] = battle.team;
	const [opponent] = battle.opponent;
	const won = me.crowns > opponent.crowns;
	const outcome = outcomeFor(me.crowns, opponent.crowns);

	// The margin is the winner's weakest standing tower, which is how close the loser came. The
	// winner always has a tower left, so the number is positive even after a 2-1.
	const winner = won ? me : opponent;
	const margin = outcome.verb
		? `${outcome.verb} by ${weakestSurvivingTowerHp(winner).toLocaleString()}hp`
		: undefined;

	// Discord builds the push notification from `content`, and embeds alone would leave it empty,
	// so the result and the score go here as Markdown headings.
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

/** An embed field. Only the trophy rows set `inline`, so that the pair sits side by side. */
type EmbedField = { name: string; value: string; inline?: boolean };

/**
 * An embed as this module builds it, before serialization. Discord's embed object allows many more
 * fields. This type covers only the ones the two message shapes use, so {@link payloadJson} accepts
 * exactly those shapes. `thumbnail` and `image` are optional because only {@link buildForm}'s embeds
 * have them; {@link buildFallbackMessage} puts the same information into `fields`.
 *
 * `timestamp` holds a `Temporal.Instant`. {@link payloadJson}'s `JSON.stringify` turns it into the
 * ISO 8601 string Discord expects, through `Temporal.Instant.prototype.toJSON`.
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
 * Serializes a webhook body and adds {@link ALLOWED_MENTIONS}. Both request shapes, the multipart
 * `payload_json` part and the text-only JSON body, go through this function, so neither can go out
 * without the mention setting. A new request shape that called `JSON.stringify` itself would leave
 * user mentions switched on.
 */
function payloadJson(message: { content: string; embeds: Embed[] }) {
	return JSON.stringify({ ...message, allowed_mentions: ALLOWED_MENTIONS });
}

/**
 * Renders both deck grids and builds the multipart body: one `payload_json` part with the content
 * and both embeds, then one `files[n]` part per grid.
 *
 * @throws When either deck fails to render. {@link tryBuildForm} catches this so the battle still
 *   posts, as text only.
 */
async function buildForm({ me, opponent, content, embedBase }: BattleContext) {
	const sides = [
		{ player: me, other: opponent, filename: "my-deck.png" },
		{ player: opponent, other: me, filename: "opp-deck.png" },
	];

	// Discord matches an embed's `attachment://` URL to an uploaded file by file name, and drops the
	// image when nothing matches. Building each file next to the embed that points at it keeps the
	// two names from drifting apart.
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
 * {@link buildForm} with a render failure turned into `undefined`, so that {@link notifyBattle} can
 * hold the form in a `const` and treat "no images" as a single case.
 *
 * @returns The multipart body, or `undefined` after logging the render error. The caller then posts
 *   the text-only message.
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
 * The text-only message: the same `content`, and one embed that lists trophies, both decks and both
 * tower troops as fields. It posts when a deck grid fails to render or Discord rejects the image
 * post, so an image problem never costs the notification itself.
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
 * Statuses that mean Discord refused the request body itself, so the message was not posted and the
 * smaller text-only body is worth a try. Discord answers 413 when a request is too large (error
 * code 40005) and 400 when the body is invalid. Discord's limits are 20 MiB per file and 25 MiB per
 * request, and an image post is about 6.6 MiB, so hitting them would take a much larger grid.
 *
 * 400 also covers errors that dropping the images can't fix, such as an embed over Discord's
 * character limits. That costs one extra POST, which fails too and then throws. Other statuses are
 * not about the body, so a smaller body would not help. A 429 means rate limiting, and the next
 * tick retries a minute later. A 5xx can arrive after Discord already stored the message, so an
 * immediate retry could post it twice.
 */
const PAYLOAD_REJECTED = new Set([400, 413]);

/** A webhook request without `method` and `signal`, which {@link postWebhook} always sets itself. */
type WebhookRequest = Omit<RequestInit, "method" | "signal">;

/**
 * Sends one POST to the webhook, with the {@link WEBHOOK_TIMEOUT_MS} timeout.
 *
 * @returns The response, unchecked. Only the caller knows whether a failed status still leaves a
 *   retry available.
 */
async function postWebhook(webhookUrl: string, request: WebhookRequest) {
	return await fetch(webhookUrl, {
		...request,
		method: "POST",
		signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
	});
}

/**
 * Finishes a webhook response with no retry left: throws on a failed status, and otherwise discards
 * the body so the connection is released. Both of {@link notifyBattle}'s final POSTs end here, so
 * they handle a response the same way.
 *
 * @throws When the status is not ok, with the status and the start of the body in the message.
 */
async function finishPost(response: Response) {
	if (!response.ok) {
		throw new Error(`Discord webhook ${String(response.status)}: ${await truncatedBody(response)}`);
	}

	await response.body?.cancel();
}

/**
 * Posts one battle to a webhook.
 *
 * It first tries the image post: multipart form data with both deck grids. `fetch` sets the
 * multipart `Content-Type`, boundary included, from the `FormData` body, so none is set by hand. If
 * rendering fails, or Discord rejects the body with a {@link PAYLOAD_REJECTED} status, it posts the
 * text-only JSON message instead, once. Without that retry, an oversized post would fail the same
 * way on every tick.
 *
 * @throws When the final POST fails: a status outside {@link PAYLOAD_REJECTED} on the image post,
 *   or any failed status on the text-only post. `poll.ts` then reports the player as failed and
 *   leaves lastBattle alone, so the next tick tries again.
 */
async function notifyBattle(webhookUrl: string, battle: Battle) {
	const ctx = battleContext(battle);

	// `undefined` when a deck failed to render. A defined form only means the images were built;
	// Discord can still reject them below, and then the post goes out as text only.
	const form = await tryBuildForm(ctx);

	if (form !== undefined) {
		const response = await postWebhook(webhookUrl, { body: form });

		// Any status outside PAYLOAD_REJECTED ends here, success included, since every
		// PAYLOAD_REJECTED status is a failure.
		if (!PAYLOAD_REJECTED.has(response.status)) {
			await finishPost(response);
			return;
		}

		log.warn(
			`Discord rejected the deck image (${hl.strong(String(response.status))}), retrying text-only: ${await truncatedBody(response)}`
		);
	}

	// The render failed or Discord rejected the images. Both cases send the same text-only body, and
	// neither gets another retry. The body is built only here because most posts never need it.
	await finishPost(
		await postWebhook(webhookUrl, {
			headers: { "Content-Type": "application/json" },
			body: payloadJson(buildFallbackMessage(ctx)),
		})
	);
}

export { notifyBattle };

/**
 * @internal Exported for tests. They check the content and the text-only message as objects instead
 *   of stubbing `fetch` and decoding a request body. `payloadJson` stays private, so production code
 *   has no way to serialize a body without {@link ALLOWED_MENTIONS}.
 */
export { battleContext, buildFallbackMessage };

/**
 * @internal Exported for tests. `discord.test.ts` derives the type of a decoded request body from it,
 *   so renaming or adding an embed field breaks the tests at compile time.
 */
export type { Embed };
