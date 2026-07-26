import * as v from "@valibot/valibot";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderDeckGrid } from "@/deck-image.ts";
import { notifyBattle } from "@/discord.ts";
import { log } from "@/log.ts";
import { BattleSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";
import { BOB, rawBattle, rawCard, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

vi.mock("@/deck-image.ts", () => ({ renderDeckGrid: vi.fn() }));
vi.mock("@/log.ts");

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
 * `form.get(...)`/`init.body` are broad union types (`string | File | …`); narrow to string before
 * parsing rather than `String(...)`-coercing a value that could be a `File`.
 */
function parseJsonString(value: unknown): unknown {
	if (typeof value !== "string") throw new TypeError("expected a JSON string");
	return JSON.parse(value);
}

/** The multipart body of the first webhook POST. */
function sentForm(): FormData {
	const body = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
	if (!(body instanceof FormData)) throw new TypeError("expected a FormData body");
	return body;
}

type Payload = {
	content: string;
	embeds: { fields?: { name: string; value: string }[]; thumbnail?: { url: string } }[];
};

/** The decoded `payload_json` of the first webhook POST. */
function sentPayload(form: FormData = sentForm()): Payload {
	return parseJsonString(form.get("payload_json")) as Payload;
}

/** The decoded JSON body of the first webhook POST, for the text-only fallback path. */
function sentFallbackPayload(): Payload {
	const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
	return parseJsonString(init?.body) as Payload;
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

	test("posts a loss with the opponent's HP margin", async () => {
		await notifyBattle(
			WEBHOOK,
			makeBattle({
				team: [player({ crowns: 1 })],
				opponent: [player({ ...BOB, crowns: 2, kingTowerHitPoints: 1000 })],
			})
		);

		expect(sentPayload().content).toBe("# Defeat\n## Alice  1 — 2  Bob\nLost by 1,000hp");
	});

	test("posts a draw with no HP margin line", async () => {
		await notifyBattle(
			WEBHOOK,
			makeBattle({
				team: [player({ crowns: 1 })],
				opponent: [player(BOB)],
			})
		);

		expect(sentPayload().content).toBe("# Draw\n## Alice  1 — 1  Bob");
	});

	test("falls back to a text-only JSON embed when deck rendering fails", async () => {
		vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));

		await notifyBattle(WEBHOOK, makeBattle());

		const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];

		expect(init?.headers).toEqual({ "Content-Type": "application/json" });

		const payload = parseJsonString(init?.body) as Payload;
		const fieldNames = payload.embeds[0]?.fields?.map((field) => field.name);

		expect(fieldNames).toContain("Deck");
		expect(fieldNames).toContain("Opponent Deck");
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
			.fn()
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
			.fn()
			.mockResolvedValueOnce(new Response("too large", { status: 413 }))
			.mockResolvedValueOnce(new Response("still bad", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 500");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("does not retry a 502, since Discord may have already accepted the message", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response("x".repeat(300), { status: 502 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 502");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("does not retry a rejected text-only fallback, to avoid retrying itself", async () => {
		vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response("too large", { status: 413 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(notifyBattle(WEBHOOK, makeBattle())).rejects.toThrow("Discord webhook 413");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("does nothing when the battle has no tracked player", async () => {
		await notifyBattle(WEBHOOK, makeBattle({ team: [] }));

		expect(fetch).not.toHaveBeenCalled();
	});

	test("drops the second embed and file when there is no opponent", async () => {
		await notifyBattle(WEBHOOK, makeBattle({ opponent: [] }));

		const form = sentForm();

		expect(sentPayload(form).embeds).toHaveLength(1);
		expect(form.get("files[1]")).toBeNull();
		expect(vi.mocked(renderDeckGrid)).toHaveBeenCalledTimes(1);
	});

	describe("trophy fields", () => {
		test("renders a positive trophy change", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({ team: [player({ startingTrophies: 5432, trophyChange: 31 })] })
			);

			const trophyField = sentPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Trophies"
			);

			expect(trophyField?.value).toBe("5,432 → 5,463 (+31)");
		});

		test("renders a negative trophy change with a single minus sign", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({ team: [player({ startingTrophies: 5432, trophyChange: -18 })] })
			);

			const trophyField = sentPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Trophies"
			);

			expect(trophyField?.value).toBe("5,432 → 5,414 (-18)");
		});

		test("renders a zero trophy change with no sign", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({ team: [player({ startingTrophies: 5432, trophyChange: 0 })] })
			);

			const trophyField = sentPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Trophies"
			);

			expect(trophyField?.value).toBe("5,432 → 5,432 (0)");
		});

		test("treats a missing trophyChange as zero", async () => {
			await notifyBattle(WEBHOOK, makeBattle({ team: [player({ startingTrophies: 5432 })] }));

			const trophyField = sentPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Trophies"
			);

			expect(trophyField?.value).toBe("5,432 → 5,432 (0)");
		});

		test("omits the Trophies field entirely when startingTrophies is absent", async () => {
			await notifyBattle(WEBHOOK, makeBattle());

			const fieldNames = sentPayload().embeds[0]?.fields?.map((field) => field.name) ?? [];

			expect(fieldNames).not.toContain("Trophies");
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
			const myFields = payload.embeds[0]?.fields;
			const opponentFields = payload.embeds[1]?.fields;

			expect(myFields?.find((field) => field.name === "Trophies")?.value).toBe(
				"5,000 → 5,010 (+10)"
			);
			expect(myFields?.find((field) => field.name === "Opponent Trophies")?.value).toBe(
				"4,800 → 4,795 (-5)"
			);
			expect(opponentFields?.find((field) => field.name === "Trophies")?.value).toBe(
				"4,800 → 4,795 (-5)"
			);
			expect(opponentFields?.find((field) => field.name === "Opponent Trophies")?.value).toBe(
				"5,000 → 5,010 (+10)"
			);
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
		beforeEach(() => {
			vi.mocked(renderDeckGrid).mockRejectedValue(new Error("icon CDN down"));
		});

		test("prefixes evolutions and heroes, joined by ' · '", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [
						player({
							cards: [
								rawCard({ name: "Knight" }),
								rawCard({ id: 26_000_001, name: "Mega Knight", evolutionLevel: 1 }),
								rawCard({ id: 26_000_002, name: "Ram Rider", evolutionLevel: 2 }),
							],
						}),
					],
				})
			);

			const deckField = sentFallbackPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Deck"
			);

			expect(deckField?.value).toBe("Knight · Evo Mega Knight · Hero Ram Rider");
		});

		test("renders an em dash for an empty deck", async () => {
			await notifyBattle(WEBHOOK, makeBattle({ team: [player({ cards: [] })] }));

			const deckField = sentFallbackPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Deck"
			);

			expect(deckField?.value).toBe("—");
		});

		test("lists support-card names, comma-separated", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [
						player({
							supportCards: [
								rawCard({ id: 159_000_000, name: "Tower Princess" }),
								rawCard({ id: 159_000_001, name: "Cannoneer" }),
							],
						}),
					],
				})
			);

			const field = sentFallbackPayload().embeds[0]?.fields?.find(
				(field) => field.name === "Tower Troop"
			);

			expect(field?.value).toBe("Tower Princess, Cannoneer");
		});

		test("omits the Tower Troop field when there are no support cards", async () => {
			await notifyBattle(WEBHOOK, makeBattle());

			const fieldNames = sentFallbackPayload().embeds[0]?.fields?.map((field) => field.name) ?? [];

			expect(fieldNames).not.toContain("Tower Troop");
		});

		test("includes the spacer field between trophy rows and deck rows when trophies are present", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({ team: [player({ startingTrophies: 5000, trophyChange: 10 })] })
			);

			const fieldNames = sentFallbackPayload().embeds[0]?.fields?.map((field) => field.name) ?? [];
			const deckIndex = fieldNames.indexOf("Deck");

			expect(fieldNames[deckIndex - 1]).toBe("​");
		});
	});

	describe("HP margin with destroyed towers", () => {
		test("skips a destroyed princess tower when computing the winner's margin", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [
						player({ crowns: 2, kingTowerHitPoints: 2500, princessTowersHitPoints: [0, 1400] }),
					],
				})
			);

			expect(sentPayload().content).toBe("# Victory\n## Alice  2 — 1  Bob\nWon by 1,400hp");
		});

		test("reports 0 when all of the winner's towers are destroyed", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [player({ crowns: 2, kingTowerHitPoints: 0, princessTowersHitPoints: [0, 0] })],
				})
			);

			expect(sentPayload().content).toBe("# Victory\n## Alice  2 — 1  Bob\nWon by 0hp");
		});

		test("omits the margin line entirely on a draw, regardless of tower state", async () => {
			await notifyBattle(
				WEBHOOK,
				makeBattle({
					team: [
						player({ crowns: 1, kingTowerHitPoints: 2500, princessTowersHitPoints: [1000, 0] }),
					],
					opponent: [player({ ...BOB, crowns: 1 })],
				})
			);

			expect(sentPayload().content).toBe("# Draw\n## Alice  1 — 1  Bob");
		});
	});
});
