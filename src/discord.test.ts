import * as v from "valibot";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderDeckGrid } from "@/deck-image.ts";
import { battleContext, buildFallbackMessage, notifyBattle } from "@/discord.ts";
import { log } from "@/log.ts";
import { BattleSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";
import { BOB, rawBattle, rawCard, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

vi.mock(import("@/deck-image.ts"), () => ({ renderDeckGrid: vi.fn<typeof renderDeckGrid>() }));
vi.mock(import("@/log.ts"));

/** A player with the tower HP fields the message's margin line is computed from. */
function player(overrides: Record<string, unknown> = {}) {
	return rawPlayer({
		kingTowerHitPoints: 4008,
		princessTowersHitPoints: [2534, 2534],
		...overrides,
	});
}

function makeBattle(overrides: Record<string, unknown> = {}): Battle {
	return v.parse(
		BattleSchema,
		rawBattle({
			gameMode: { name: "Ladder" },
			team: [player()],
			opponent: [player(BOB)],
			...overrides,
		})
	);
}

/**
 * The shared battle context for a battle, built directly. Everything downstream of it is pure
 * formatting, so the tests below assert on it (and on {@link fallbackFor}) rather than posting a
 * message and decoding the strings back out of an HTTP body. The `fetch`-driven helpers further
 * down are for the tests that are genuinely about the send path.
 */
function contextFor(overrides: Record<string, unknown> = {}) {
	const battle = makeBattle(overrides);
	return battleContext(battle, battle.team[0]);
}

/** The text-only message body for a battle, built directly — no render failure to stage, no POST. */
function fallbackFor(overrides: Record<string, unknown> = {}) {
	return buildFallbackMessage(contextFor(overrides)) as unknown as Payload;
}

/**
 * `form.get(...)`/`init.body` are broad union types (`string | File | …`); narrow to string before
 * parsing rather than `String(...)`-coercing a value that could be a `File`.
 */
function parseJsonString(value: unknown): unknown {
	if (typeof value !== "string") throw new TypeError("expected a JSON string");
	return JSON.parse(value);
}

/** The multipart body of the first webhook POST. */
function sentForm() {
	const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
	if (!(body instanceof FormData)) throw new TypeError("expected a FormData body");
	return body;
}

type Payload = {
	content: string;
	allowed_mentions?: { parse: string[] };
	embeds: {
		fields?: { name: string; value: string }[];
		thumbnail?: { url: string };
		author?: { url: string };
		footer?: { text: string };
		timestamp?: string;
	}[];
};

/** The decoded `payload_json` of the first webhook POST. */
function sentPayload(form: FormData = sentForm()) {
	return parseJsonString(form.get("payload_json")) as Payload;
}

/** The decoded JSON body of the first webhook POST, for the text-only fallback path. */
function sentFallbackPayload() {
	const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
	return parseJsonString(init?.body) as Payload;
}

/** One embed field's value by name, or undefined when the embed didn't carry that field. */
function fieldValue(payload: Payload, name: string, embed = 0) {
	return payload.embeds[embed]?.fields?.find((field) => field.name === name)?.value;
}

/** Every field name on an embed, in order — for asserting which fields were emitted at all. */
function fieldNames(payload: Payload, embed = 0) {
	return payload.embeds[embed]?.fields?.map((field) => field.name) ?? [];
}

beforeEach(() => {
	vi.mocked(renderDeckGrid).mockResolvedValue(new Uint8Array([1, 2, 3]));
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.resolve(new Response()))
	);
});

describe("notifyBattle", () => {
	test("posts a win with the winner's HP margin and both decks attached", async () => {
		await notifyBattle(WEBHOOK, makeBattle({ team: [player({ crowns: 2 })] }));

		const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
		const form = sentForm();
		const payload = sentPayload(form);

		expect(url).toBe(WEBHOOK);
		expect(payload.content).toBe("# Victory\n## Alice  2 — 1  Bob\nWon by 2,534hp");
		expect(payload.embeds).toHaveLength(2);
		expect(form.get("files[0]")).toBeInstanceOf(File);
		expect(form.get("files[1]")).toBeInstanceOf(File);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	test("reports a loss with the opponent's HP margin", () => {
		const { content } = contextFor({
			team: [player({ crowns: 1 })],
			opponent: [player({ ...BOB, crowns: 2, kingTowerHitPoints: 1000 })],
		});

		expect(content).toBe("# Defeat\n## Alice  1 — 2  Bob\nLost by 1,000hp");
	});

	test("reports a draw with no HP margin line", () => {
		const { content } = contextFor({
			team: [player({ crowns: 1 })],
			opponent: [player(BOB)],
		});

		expect(content).toBe("# Draw\n## Alice  1 — 1  Bob");
	});

	test("falls back to a text-only JSON embed when deck rendering fails", async () => {
		vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));

		await notifyBattle(WEBHOOK, makeBattle());

		const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];

		expect(init?.headers).toEqual({ "Content-Type": "application/json" });

		const names = fieldNames(parseJsonString(init?.body) as Payload);

		expect(names).toContain("Deck");
		expect(names).toContain("Opponent Deck");
		expect(log.error).toHaveBeenCalled();
	});

	test("throws when the webhook responds with a non-ok status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("x".repeat(300), { status: 502 })))
		);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 502");
	});

	test("retries with the text-only fallback when Discord rejects the image payload", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("too large", { status: 413 }))
			.mockResolvedValueOnce(new Response());
		vi.stubGlobal("fetch", fetchMock);

		await notifyBattle(WEBHOOK, makeBattle());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The retry's body is the JSON text fallback, not the multipart FormData the first attempt sent.
		expect(typeof vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe("string");
	});

	test("rejects when the text-only retry also fails", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("too large", { status: 413 }))
			.mockResolvedValueOnce(new Response("still bad", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 500");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("does not retry a 502, since Discord may have already accepted the message", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("x".repeat(300), { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 502");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("does not retry a rejected text-only fallback, to avoid retrying itself", async () => {
		vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("too large", { status: 413 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 413");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// battleTime is a Temporal.Instant in the domain and only becomes a string when payloadJson
	// stringifies the body, via Instant.prototype.toJSON. Asserted on the serialized payload rather
	// than on embedBase(), because what matters is the bytes Discord receives: reading the embed
	// object directly would see the Instant and would not catch a serialization regression.
	test("serializes the embed timestamp as an ISO string Discord can parse", async () => {
		await notifyBattle(WEBHOOK, makeBattle());

		const [embed] = sentPayload().embeds;

		expect(embed?.timestamp).toBe("2024-01-15T14:30:22Z");
		expect(Number.isNaN(new Date(embed?.timestamp ?? "").getTime())).toBe(false);
	});

	test("deep-links each side's embed to that side's own battle log", () => {
		const { me, opponent, embedBase } = contextFor();

		// Soft: the failure mode worth seeing whole is both sides pointing at the same player.
		expect.soft(embedBase(me).author.url).toBe("https://royaleapi.com/player/ABC123/battles");
		expect.soft(embedBase(opponent).author.url).toBe("https://royaleapi.com/player/DEF456/battles");
	});

	describe("footer", () => {
		test("names the game mode, with its underscores spaced out", () => {
			const { me, opponent, embedBase } = contextFor({ gameMode: { name: "Path_of_Legends" } });

			// Both sides share one footer object, so both must read the same mode.
			expect.soft(embedBase(me).footer.text).toBe("Path of Legends");
			expect.soft(embedBase(opponent).footer.text).toBe("Path of Legends");
		});

		test("falls back to the battle type when the entry carries no game mode", () => {
			// gameMode is optional on BattleSchema (modes without one exist), and an empty footer would
			// leave the embed with no indication of what was played.
			const { me, embedBase } = contextFor({ gameMode: undefined, type: "PvP" });

			expect(embedBase(me).footer.text).toBe("PvP");
		});
	});

	test("attaches one embed and one deck image per side", async () => {
		await notifyBattle(WEBHOOK, makeBattle());

		const form = sentForm();

		expect(sentPayload(form).embeds).toHaveLength(2);
		expect(form.get("files[1]")).toBeInstanceOf(File);
		expect(vi.mocked(renderDeckGrid)).toHaveBeenCalledTimes(2);
	});

	describe("trophy fields", () => {
		// One table rather than four near-identical tests: every row is the same call with a different
		// trophyChange, and the sign rule (+ only when positive, nothing on 0 or on the already-signed
		// negative) is easiest to read as a column.
		test.for([
			{ change: 31, as: "a positive change with a + sign", expected: "5,432 → 5,463 (+31)" },
			{ change: -18, as: "a negative change with one minus sign", expected: "5,432 → 5,414 (-18)" },
			{ change: 0, as: "a zero change unsigned", expected: "5,432 → 5,432 (0)" },
			{ change: undefined, as: "a missing change as zero", expected: "5,432 → 5,432 (0)" },
		])("renders $as", ({ change, expected }) => {
			const message = fallbackFor({
				team: [player({ startingTrophies: 5432, trophyChange: change })],
			});

			expect(fieldValue(message, "Trophies")).toBe(expected);
		});

		test("omits the Trophies field entirely when startingTrophies is absent", () => {
			expect(fieldNames(fallbackFor())).not.toContain("Trophies");
		});

		test("labels each embed's fields from its own subject's perspective", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [player({ startingTrophies: 5000, trophyChange: 10 })],
					opponent: [player({ ...BOB, startingTrophies: 4800, trophyChange: -5 })],
				})
			);

			const payload = sentPayload();

			// Embed 0 is the tracked player's, embed 1 the opponent's — each labels the same pair of
			// numbers from its own side, so the two embeds' values are mirror images. Soft, so a swapped
			// perspective reports all four cells at once rather than only the first mismatch.
			expect.soft(fieldValue(payload, "Trophies", 0)).toBe("5,000 → 5,010 (+10)");
			expect.soft(fieldValue(payload, "Opponent Trophies", 0)).toBe("4,800 → 4,795 (-5)");
			expect.soft(fieldValue(payload, "Trophies", 1)).toBe("4,800 → 4,795 (-5)");
			expect.soft(fieldValue(payload, "Opponent Trophies", 1)).toBe("5,000 → 5,010 (+10)");
		});
	});

	describe("tower-troop thumbnail", () => {
		test("uses curated art for a known tower troop", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [player({ supportCards: [rawCard({ id: 159_000_000, name: "Tower Princess" })] })],
				})
			);

			expect(sentPayload().embeds[0]?.thumbnail?.url).toBe(
				"https://liquipedia.net/commons/images/5/54/Clash_Royale_Card_Tower_Princess.png"
			);
		});

		test("falls back to the API icon for an unknown tower troop", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [
						player({
							supportCards: [
								rawCard({
									id: 159_000_099,
									name: "Mystery Troop",
									iconUrls: { medium: "https://api.clashroyale.com/mystery.png" },
								}),
							],
						}),
					],
				})
			);

			expect(sentPayload().embeds[0]?.thumbnail?.url).toBe(
				"https://api.clashroyale.com/mystery.png"
			);
		});

		test("omits the thumbnail when the player has no support cards", async () => {
			await notifyBattle(WEBHOOK, makeBattle());

			expect(sentPayload().embeds[0]?.thumbnail).toBeUndefined();
		});
	});

	describe("deck name formatting (fallback)", () => {
		test("prefixes evolutions and heroes, joined by ' · '", () => {
			const message = fallbackFor({
				team: [
					player({
						cards: [
							rawCard({ name: "Knight" }),
							rawCard({ id: 26_000_001, name: "Mega Knight", evolutionLevel: 1 }),
							rawCard({ id: 26_000_002, name: "Ram Rider", evolutionLevel: 2 }),
						],
					}),
				],
			});

			expect(fieldValue(message, "Deck")).toBe("Knight · Evo Mega Knight · Hero Ram Rider");
		});

		test("renders an em dash for an empty deck", () => {
			const message = fallbackFor({ team: [player({ cards: [] })] });

			expect(fieldValue(message, "Deck")).toBe("—");
		});

		test("lists support-card names, comma-separated", () => {
			const message = fallbackFor({
				team: [
					player({
						supportCards: [
							rawCard({ id: 159_000_000, name: "Tower Princess" }),
							rawCard({ id: 159_000_001, name: "Cannoneer" }),
						],
					}),
				],
			});

			expect(fieldValue(message, "Tower Troop")).toBe("Tower Princess, Cannoneer");
		});

		test("omits the Tower Troop field when there are no support cards", () => {
			expect(fieldNames(fallbackFor())).not.toContain("Tower Troop");
		});

		test("includes the spacer field between trophy rows and deck rows when trophies are present", () => {
			const names = fieldNames(
				fallbackFor({ team: [player({ startingTrophies: 5000, trophyChange: 10 })] })
			);
			const deckIndex = names.indexOf("Deck");

			expect(names[deckIndex - 1]).toBe("​");
		});
	});

	describe("HP margin with destroyed towers", () => {
		test("skips a destroyed princess tower when computing the winner's margin", () => {
			const { content } = contextFor({
				team: [player({ crowns: 2, kingTowerHitPoints: 2500, princessTowersHitPoints: [0, 1400] })],
			});

			expect(content).toBe("# Victory\n## Alice  2 — 1  Bob\nWon by 1,400hp");
		});

		test("reports 0 when all of the winner's towers are destroyed", () => {
			const { content } = contextFor({
				team: [player({ crowns: 2, kingTowerHitPoints: 0, princessTowersHitPoints: [0, 0] })],
			});

			expect(content).toBe("# Victory\n## Alice  2 — 1  Bob\nWon by 0hp");
		});

		test("omits the margin line entirely on a draw, regardless of tower state", () => {
			const { content } = contextFor({
				team: [player({ crowns: 1, kingTowerHitPoints: 2500, princessTowersHitPoints: [1000, 0] })],
				opponent: [player({ ...BOB, crowns: 1 })],
			});

			expect(content).toBe("# Draw\n## Alice  1 — 1  Bob");
		});
	});

	describe("mention suppression", () => {
		test("suppresses mentions on the multipart payload", async () => {
			await notifyBattle(WEBHOOK, makeBattle());

			expect(sentPayload().allowed_mentions).toEqual({ parse: [] });
		});

		test("suppresses mentions on the text-only fallback payload", async () => {
			vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));

			await notifyBattle(WEBHOOK, makeBattle());

			expect(sentFallbackPayload().allowed_mentions).toEqual({ parse: [] });
		});

		test("carries a mention-shaped opponent name verbatim without enabling it to ping", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({ opponent: [player({ ...BOB, name: "@everyone <@123456789012345678>" })] })
			);

			const payload = sentPayload();

			expect(payload.content).toContain("@everyone <@123456789012345678>");
			expect(payload.allowed_mentions).toEqual({ parse: [] });
		});
	});
});
