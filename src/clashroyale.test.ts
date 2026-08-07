import { describe, expect, test, vi } from "vitest";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { log } from "@/log.ts";
import { DECK_SIZE } from "@/schema.ts";
import { duelBattle, rawBattle, rawCard, rawPlayer } from "@/testing/fixtures.ts";

vi.mock("@/log.ts");

function battle(battleTime: string, teamSize = 1) {
	return rawBattle({ battleTime, team: Array.from({ length: teamSize }, () => rawPlayer()) });
}

describe("latestBattle", () => {
	test("returns undefined for an empty log", () => {
		const result = latestBattle([]);

		expect(result.battle).toBeUndefined();
		expect(result.drifted).toBe(false);
	});

	test("returns undefined when every entry is ineligible or malformed", () => {
		const entries = [battle("20240101T000000.000Z", 2), "garbage", {}, 42];

		const result = latestBattle(entries);

		expect(result.battle).toBeUndefined();
		expect(result.drifted).toBe(false);
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("picks the newest eligible (1v1) battle among mixed entries", () => {
		const newer = battle("20240115T143022.000Z");
		const older = battle("20240101T000000.000Z");

		const entries = [newer, older, "garbage"];

		expect(latestBattle(entries).battle?.battleTime).toBe("2024-01-15T14:30:22.000Z");
	});

	test("skips leading 2v2 and malformed entries to reach the first eligible one", () => {
		const twoVsTwo = battle("20240201T000000.000Z", 2);
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([twoVsTwo, "garbage", eligible]).battle?.battleTime).toBe(
			"2024-01-01T00:00:00.000Z"
		);
	});

	// The battlelog arrives newest-first (verified against the live proxy), so selection trusts
	// position rather than comparing timestamps — pinned here because it is an assumption about an
	// undocumented API ordering, not a property of the data.
	test("takes the first eligible entry, not the chronologically newest", () => {
		const first = battle("20240101T000000.000Z");
		const outOfOrder = battle("20240201T000000.000Z");

		expect(latestBattle([first, outOfOrder]).battle?.battleTime).toBe("2024-01-01T00:00:00.000Z");
	});

	test("skips a duel (16 concatenated cards) to reach an ordinary 1v1 further down the log", () => {
		const duel = duelBattle({ battleTime: "20240201T000000.000Z" });
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([duel, eligible]).battle?.battleTime).toBe("2024-01-01T00:00:00.000Z");
	});

	test("skips a duel with 24 concatenated cards (3-deck variant) too", () => {
		const duel = duelBattle({ battleTime: "20240201T000000.000Z" }, 3);
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([duel, eligible]).battle?.battleTime).toBe("2024-01-01T00:00:00.000Z");
	});

	test("an 8-card deck is still eligible — the duel check must not be off by one", () => {
		const eightCards = rawBattle({
			team: [rawPlayer({ cards: Array.from({ length: DECK_SIZE }, () => rawCard()) })],
		});

		expect(latestBattle([eightCards]).battle).toBeDefined();
	});

	test("a 9-card deck is already ineligible — one more than a real deck trips the duel check", () => {
		const nineCards = rawBattle({
			team: [rawPlayer({ cards: Array.from({ length: DECK_SIZE + 1 }, () => rawCard()) })],
		});
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([nineCards, eligible]).battle?.battleTime).toBe("2024-01-01T00:00:00.000Z");
	});

	test("returns undefined when the newest eligible entry fails full schema validation", () => {
		const newest = rawBattle({
			battleTime: "20240115T143022.000Z",
			team: [rawPlayer({ cards: [rawCard({ iconUrls: { medium: "not-a-url" } })] })],
		});
		const older = battle("20240101T000000.000Z");

		const result = latestBattle([newest, older]);

		expect(result.battle).toBeUndefined();
		expect(result.drifted).toBe(true);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("failed schema validation"),
			expect.anything()
		);
	});
});

describe("fetchBattlelog", () => {
	test("requests the proxy URL with the bearer token and accept header", async () => {
		const fetchMock = vi.fn(() => Response.json([{ any: "thing" }]));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchBattlelog("#ABC123", "my-token");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://proxy.royaleapi.dev/v1/players/%23ABC123/battlelog",
			{
				headers: { Authorization: "Bearer my-token", Accept: "application/json" },
				signal: expect.any(AbortSignal) as AbortSignal,
			}
		);
		expect(result).toEqual([{ any: "thing" }]);
	});

	test("throws with the status and tag context on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Response("x".repeat(300), { status: 500 }))
		);

		await expect(fetchBattlelog("#ABC123", "my-token")).rejects.toThrow(
			"Clash Royale API 500 for #ABC123"
		);
	});
});
