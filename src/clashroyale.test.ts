import { describe, expect, it, vi } from "vitest";

import { fetchBattlelog, latestBattle } from "@/clashroyale.ts";
import { log } from "@/log.ts";
import { rawBattle, rawCard, rawPlayer } from "@/testing/fixtures.ts";

vi.mock("@/log.ts");

function battle(battleTime: string, teamSize = 1) {
	return rawBattle({ battleTime, team: Array.from({ length: teamSize }, () => rawPlayer()) });
}

describe("latestBattle", () => {
	it("returns undefined for an empty log", () => {
		expect(latestBattle([])).toBeUndefined();
	});

	it("returns undefined when every entry is ineligible or malformed", () => {
		const entries = [battle("20240101T000000.000Z", 2), "garbage", {}, 42];

		expect(latestBattle(entries)).toBeUndefined();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("picks the newest eligible (1v1) battle among mixed entries", () => {
		const older = battle("20240101T000000.000Z");
		const newer = battle("20240115T143022.000Z");

		const entries = [older, newer, "garbage"];

		expect(latestBattle(entries)?.battleTime).toBe("2024-01-15T14:30:22.000Z");
	});

	it("ignores a 2v2 entry even if it is chronologically newest", () => {
		const eligible = battle("20240101T000000.000Z");
		const twoVsTwo = battle("20240201T000000.000Z", 2);

		expect(latestBattle([eligible, twoVsTwo])?.battleTime).toBe("2024-01-01T00:00:00.000Z");
	});

	it("returns undefined when the newest eligible entry fails full schema validation", () => {
		const newest = rawBattle({
			battleTime: "20240115T143022.000Z",
			team: [rawPlayer({ cards: [rawCard({ iconUrls: { medium: "not-a-url" } })] })],
		});
		const older = battle("20240101T000000.000Z");

		expect(latestBattle([older, newest])).toBeUndefined();
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("failed schema validation"),
			expect.anything()
		);
	});
});

describe("fetchBattlelog", () => {
	it("requests the proxy URL with the bearer token and accept header", async () => {
		const fetchMock = vi.fn(() => Response.json([{ any: "thing" }], { status: 200 }));
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

	it("throws with the status and tag context on a non-ok response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Response("x".repeat(300), { status: 500 }))
		);

		await expect(fetchBattlelog("#ABC123", "my-token")).rejects.toThrow(
			"Clash Royale API 500 for #ABC123"
		);
	});
});
