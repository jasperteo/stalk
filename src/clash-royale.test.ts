/**
 * @module
 *
 * Tests for `clash-royale.ts`: which entry {@link latestBattle} selects from a raw battle log, and
 * how {@link fetchBattlelog} builds its request and handles a bad response. `fetch` is stubbed, so
 * nothing reaches the network.
 */

import * as v from "valibot";
import { describe, expect, test, vi } from "vitest";

import { fetchBattlelog, latestBattle } from "@/clash-royale.ts";
import { log } from "@/log.ts";
import { DECK_SIZE } from "@/schema.ts";
import { duelBattle, rawBattle, rawCard, rawPlayer } from "@/testing/fixtures.ts";

vi.mock(import("@/log.ts"));

/** A raw battle at `battleTime`. A `teamSize` of 2 makes it a 2v2 on the tracked player's side. */
function battle(battleTime: string, teamSize = 1) {
	return rawBattle({ battleTime, team: Array.from({ length: teamSize }, () => rawPlayer()) });
}

/** An `Instant` to compare a selected battle's `battleTime` against, since the schema outputs one. */
function at(iso: string) {
	return Temporal.Instant.from(iso);
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

	test("skips leading 2v2 and malformed entries to reach the first eligible one", () => {
		const twoVsTwo = battle("20240201T000000.000Z", 2);
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([twoVsTwo, "garbage", eligible]).battle?.battleTime).toEqual(
			at("2024-01-01T00:00:00.000Z")
		);
	});

	// Selection relies on the API's newest-first order and never compares timestamps. Supercell does
	// not document that order, so this test records the assumption: position wins even when a later
	// entry is newer.
	test("takes the first eligible entry, not the chronologically newest", () => {
		const first = battle("20240101T000000.000Z");
		const outOfOrder = battle("20240201T000000.000Z");

		expect(latestBattle([first, outOfOrder]).battle?.battleTime).toEqual(
			at("2024-01-01T00:00:00.000Z")
		);
	});

	// A two-deck and a three-deck Duel fail the same `cards.length > DECK_SIZE` check. The exact
	// boundary is covered by the 8-card and 9-card tests below.
	test.for([
		{ decks: 2, as: "16 concatenated cards" },
		{ decks: 3, as: "24 concatenated cards (3-deck variant)" },
	] as const)(
		"skips a duel with $as to reach an ordinary 1v1 further down the log",
		({ decks }) => {
			const duel = duelBattle({ battleTime: "20240201T000000.000Z" }, decks);
			const eligible = battle("20240101T000000.000Z");

			expect(latestBattle([duel, eligible]).battle?.battleTime).toEqual(
				at("2024-01-01T00:00:00.000Z")
			);
		}
	);

	test("an 8-card deck is still eligible; the duel check must not be off by one", () => {
		const eightCards = rawBattle({
			team: [rawPlayer({ cards: Array.from({ length: DECK_SIZE }, () => rawCard()) })],
		});

		expect(latestBattle([eightCards]).battle).toBeDefined();
	});

	test("a 9-card deck is already ineligible; one more than a real deck trips the duel check", () => {
		const nineCards = rawBattle({
			team: [rawPlayer({ cards: Array.from({ length: DECK_SIZE + 1 }, () => rawCard()) })],
		});
		const eligible = battle("20240101T000000.000Z");

		expect(latestBattle([nineCards, eligible]).battle?.battleTime).toEqual(
			at("2024-01-01T00:00:00.000Z")
		);
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

		// One request per call, with the tag's `#` encoded as `%23`.
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			"https://proxy.royaleapi.dev/v1/players/%23ABC123/battlelog",
			{
				headers: { Authorization: "Bearer my-token", Accept: "application/json" },
				method: "GET",
				signal: expect.any(AbortSignal) as AbortSignal,
			}
		);
		expect(result).toEqual([{ any: "thing" }]);
	});

	test("rejects when the proxy returns JSON that isn't an array", async () => {
		// An ok response whose body is an object, not a battle log. It has to fail here, where
		// `poll.ts` reports it as `failed`, and not later as a TypeError from `.find` in
		// `latestBattle`.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Response.json({ reason: "notFound" }))
		);

		await expect(fetchBattlelog("#ABC123", "my-token")).rejects.toThrow(v.ValiError);
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
