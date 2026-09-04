import * as v from "valibot";
import { describe, expect, test } from "vitest";

import {
	BattleSchema,
	isEligibleBattle,
	LastBattleSchema,
	TargetsEnvSchema,
	TokenEnvSchema,
} from "@/schema.ts";
import { duelBattle, rawBattle, rawCard, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

describe("BattleSchema", () => {
	test("normalizes a valid battle", () => {
		const result = v.parse(BattleSchema, rawBattle());

		expect(result.battleTime).toEqual(Temporal.Instant.from("2024-01-15T14:30:22Z"));
		expect(result.team[0]?.tag).toBe("#ABC123");
		expect(result.opponent[0]?.tag).toBe("#DEF456");
	});

	test("adds a leading # only when missing, and always uppercases", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ tag: "#already-hashed" })] })
		);

		expect(result.team[0]?.tag).toBe("#ALREADY-HASHED");
	});

	test("defaults kingTowerHitPoints to 0 and pads princessTowersHitPoints to a 2-tuple", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ princessTowersHitPoints: [1000] })] })
		);

		expect(result.team[0]?.kingTowerHitPoints).toBe(0);
		expect(result.team[0]?.princessTowersHitPoints).toEqual([1000, 0]);
	});

	test("defaults princessTowersHitPoints to [0, 0] when absent", () => {
		const result = v.parse(BattleSchema, rawBattle());

		expect(result.team[0]?.princessTowersHitPoints).toEqual([0, 0]);
	});

	test("falls back an unknown evolutionLevel to undefined instead of failing", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ cards: [rawCard({ evolutionLevel: 99 })] })] })
		);

		expect(result.team[0]?.cards[0]?.evolutionLevel).toBeUndefined();
	});

	test("keeps a known evolutionLevel", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ cards: [rawCard({ evolutionLevel: 1 })] })] })
		);

		expect(result.team[0]?.cards[0]?.evolutionLevel).toBe(1);
	});

	test("rejects an invalid battleTime", () => {
		const result = v.safeParse(BattleSchema, rawBattle({ battleTime: "not-a-date" }));

		expect(result.success).toBe(false);
	});

	// The runtime half of the one-per-side tuples: a shape the type rules out must not parse either.
	describe("one player per side", () => {
		test.for([
			{ as: "an empty team", battle: { team: [] } },
			{ as: "an empty opponent", battle: { opponent: [] } },
			// `strictTuple`, not `tuple`, specifically for this row: a plain `v.tuple` would strip the
			// second player and post a 2v2 as though it were a 1v1.
			{ as: "a two-player team", battle: { team: [rawPlayer(), rawPlayer()] } },
			{ as: "a two-player opponent", battle: { opponent: [rawPlayer(), rawPlayer()] } },
		] as const)("rejects $as", ({ battle }) => {
			expect(v.safeParse(BattleSchema, rawBattle(battle)).success).toBe(false);
		});
	});
});

describe("LastBattleSchema", () => {
	test("parses a stored timestamp into an Instant", () => {
		expect(v.parse(LastBattleSchema, "20240115T143022.000Z")).toEqual(
			Temporal.Instant.from("2024-01-15T14:30:22Z")
		);
	});

	// The property that matters now that the output is an Instant rather than a canonical string: a
	// value stored by any version, whether compact as the API sends it or the extended form poll.ts
	// writes, parses to the same instant, so it compares directly against a freshly fetched battle.
	test("parses the compact and extended forms to the same instant", () => {
		expect(v.parse(LastBattleSchema, "20240115T143022.000Z")).toEqual(
			v.parse(LastBattleSchema, "2024-01-15T14:30:22.000Z")
		);
	});

	test("rejects a garbage lastBattle value", () => {
		expect(v.safeParse(LastBattleSchema, "garbage").success).toBe(false);
	});
});

describe("isEligibleBattle", () => {
	test("accepts a 1v1 entry", () => {
		expect(isEligibleBattle(rawBattle())).toBe(true);
	});

	test("rejects a 2v2 entry", () => {
		expect(isEligibleBattle(rawBattle({ team: [rawPlayer(), rawPlayer()] }))).toBe(false);
	});

	test("rejects a malformed entry", () => {
		expect(isEligibleBattle({ battleTime: "not-a-date", team: [rawPlayer()] })).toBe(false);
	});

	test("rejects a duel entry", () => {
		expect(isEligibleBattle(duelBattle())).toBe(false);
	});

	// Pinned because the gate, not BattleSchema, is what must reject this. See EligibleBattleSchema's
	// JSDoc for the stuck state that would otherwise result.
	test("rejects an entry with no opponent, so the scan skips it rather than reporting drift", () => {
		expect(isEligibleBattle(rawBattle({ opponent: [] }))).toBe(false);
	});
});

describe("TokenEnvSchema", () => {
	test("accepts a non-empty string", () => {
		expect(v.safeParse(TokenEnvSchema, "some-token").success).toBe(true);
	});

	test("rejects an empty string", () => {
		expect(v.safeParse(TokenEnvSchema, "").success).toBe(false);
	});

	test("rejects undefined", () => {
		expect(v.safeParse(TokenEnvSchema, undefined).success).toBe(false);
	});
});

describe("TargetsEnvSchema", () => {
	test("parses and normalizes a valid TARGETS JSON array", () => {
		const raw = JSON.stringify([{ tag: "abc", webhook: WEBHOOK }]);

		const result = v.parse(TargetsEnvSchema, raw);

		expect(result).toEqual([{ tag: "#ABC", webhook: WEBHOOK }]);
	});

	test("rejects malformed JSON", () => {
		expect(v.safeParse(TargetsEnvSchema, "{not json").success).toBe(false);
	});

	test("rejects a non-array JSON value", () => {
		expect(v.safeParse(TargetsEnvSchema, JSON.stringify({ tag: "abc" })).success).toBe(false);
	});

	test("rejects an entry with a non-URL webhook", () => {
		const raw = JSON.stringify([{ tag: "abc", webhook: "not-a-url" }]);

		expect(v.safeParse(TargetsEnvSchema, raw).success).toBe(false);
	});
});
