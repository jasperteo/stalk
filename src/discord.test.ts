/**
 * @module
 *
 * Tests for `discord.ts`. `renderDeckGrid` is mocked and `fetch` is stubbed, so no image is drawn
 * and nothing is sent. Formatting tests read the message objects directly, through
 * {@link contextFor} and {@link fallbackFor}. Tests about sending decode the body that reached the
 * stubbed `fetch`.
 */

import { Buffer } from "node:buffer";

import * as v from "valibot";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderDeckGrid } from "@/deck-image.ts";
import { battleContext, buildFallbackMessage, notifyBattle } from "@/discord.ts";
import type { Embed } from "@/discord.ts";
import { log } from "@/log.ts";
import type { Battle } from "@/schema.ts";
import { BattleSchema } from "@/schema.ts";
import { BOB, rawBattle, rawCard, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

vi.mock(import("@/deck-image.ts"), () => ({ renderDeckGrid: vi.fn<typeof renderDeckGrid>() }));
vi.mock(import("@/log.ts"));

/** A raw player with full tower HP, the fields the margin line is computed from. */
function player(overrides: Record<string, unknown> = {}) {
	return rawPlayer({
		kingTowerHitPoints: 4008,
		princessTowersHitPoints: [2534, 2534],
		...overrides,
	});
}

/** A validated Ladder battle between two {@link player}s, with overrides applied before parsing. */
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
 * The `battleContext` for a battle. The content line and the embed bases are plain values, so tests
 * of their formatting read them here instead of posting and decoding a request body. The helpers
 * that read `fetch` calls are for tests about sending.
 */
function contextFor(overrides: Record<string, unknown> = {}) {
	return battleContext(makeBattle(overrides));
}

/**
 * The text-only message for a battle, built directly, with no render failure to stage and no POST.
 *
 * The cast goes through `unknown` because {@link Payload} describes the body after serialization,
 * where `timestamp` is a string. Before serialization it is a `Temporal.Instant`, so TypeScript
 * rejects a direct `as Payload`. The field reads in these tests don't touch `timestamp`.
 */
function fallbackFor(overrides: Record<string, unknown> = {}) {
	return buildFallbackMessage(contextFor(overrides)) as unknown as Payload;
}

/**
 * Parses a request body part that should be a JSON string. `form.get()` and `init.body` have wide
 * union types that include `File`, so this checks for a string instead of converting whatever
 * arrives with `String()`.
 */
function parseJsonString(value: unknown): unknown {
	if (typeof value !== "string") throw new TypeError("expected a JSON string");
	return JSON.parse(value);
}

/** The `FormData` body of the first webhook POST, the image post. */
function sentForm() {
	const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
	if (!(body instanceof FormData)) throw new TypeError("expected a FormData body");
	return body;
}

/**
 * A request body after serialization. The embed type comes from production's {@link Embed}, so
 * renaming an embed field breaks these tests at compile time. The only change is `timestamp`, which
 * `JSON.stringify` turns from a `Temporal.Instant` into a string.
 */
type Payload = {
	content: string;
	allowed_mentions?: { parse: string[] };
	embeds: (Omit<Embed, "timestamp"> & { timestamp: string })[];
};

/** The parsed `payload_json` part of an image post's form, by default the first POST's. */
function sentPayload(form: FormData = sentForm()) {
	return parseJsonString(form.get("payload_json")) as Payload;
}

/** The decoded JSON body of the first webhook POST, when that POST is the text-only message. */
function sentFallbackPayload() {
	const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
	return parseJsonString(init?.body) as Payload;
}

/** The value of the named field in one embed, or `undefined` when the embed has no such field. */
function fieldValue(payload: Payload, name: string, embed = 0) {
	return payload.embeds[embed]?.fields?.find((field) => field.name === name)?.value;
}

/** The names of an embed's fields, in order, for checking which fields exist. */
function fieldNames(payload: Payload, embed = 0) {
	return payload.embeds[embed]?.fields?.map((field) => field.name) ?? [];
}

beforeEach(() => {
	vi.mocked(renderDeckGrid).mockResolvedValue(Buffer.from([1, 2, 3]));
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
		// One render per side. Reusing one grid for both embeds would otherwise only show up as two
		// identical images in Discord.
		expect(vi.mocked(renderDeckGrid)).toHaveBeenCalledTimes(2);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	test("reports a loss with the opponent's HP margin", () => {
		const { content } = contextFor({
			team: [player({ crowns: 1 })],
			opponent: [player({ ...BOB, crowns: 2, kingTowerHitPoints: 1000 })],
		});

		expect(content).toBe("# Defeat\n## Alice  1 — 2  Bob\nLost by 1,000hp");
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

	test("retries with the text-only fallback when Discord rejects the image payload", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("too large", { status: 413 }))
			.mockResolvedValueOnce(new Response());
		vi.stubGlobal("fetch", fetchMock);

		await notifyBattle(WEBHOOK, makeBattle());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The retry sends the text-only JSON string, not the `FormData` of the first attempt.
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

	// The embed holds `battleTime` as a `Temporal.Instant`, and it only becomes a string when
	// `payloadJson` serializes the body. The test reads the serialized body, since that string is
	// what Discord parses; reading the embed object would only see the `Instant`.
	test("serializes the embed timestamp as an ISO string Discord can parse", async () => {
		await notifyBattle(WEBHOOK, makeBattle());

		const [embed] = sentPayload().embeds;

		expect(embed?.timestamp).toBe("2024-01-15T14:30:22Z");
		expect(Number.isNaN(new Date(embed?.timestamp ?? "").getTime())).toBe(false);
	});

	test("deep-links each side's embed to that side's own battle log", () => {
		const { me, opponent, embedBase } = contextFor();

		// Soft assertions, so that both sides linking to the same player shows up as two failures.
		expect.soft(embedBase(me).author.url).toBe("https://royaleapi.com/player/ABC123/battles");
		expect.soft(embedBase(opponent).author.url).toBe("https://royaleapi.com/player/DEF456/battles");
	});

	describe("footer", () => {
		test("names the game mode, with its underscores spaced out", () => {
			const { me, opponent, embedBase } = contextFor({ gameMode: { name: "Path_of_Legends" } });

			// Both embeds use the same footer object, so both show the mode.
			expect.soft(embedBase(me).footer.text).toBe("Path of Legends");
			expect.soft(embedBase(opponent).footer.text).toBe("Path of Legends");
		});

		test("falls back to the battle type when the entry carries no game mode", () => {
			// `gameMode` is optional in `BattleSchema`. Without this fallback the footer would not say
			// what kind of battle it was.
			const { me, embedBase } = contextFor({ gameMode: undefined, type: "PvP" });

			expect(embedBase(me).footer.text).toBe("PvP");
		});
	});

	describe("trophy fields", () => {
		// Each row changes only `trophyChange`. Side by side, the rows show the sign rule: `+` before a
		// gain, nothing before 0, and a loss keeps the minus sign it already has.
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

			// Embed 0 belongs to the tracked player and embed 1 to the opponent. Each labels the same
			// two rows from its own side, so the values swap between them. Soft assertions report all
			// four cells when the sides are mixed up.
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
