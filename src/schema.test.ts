import * as v from "@valibot/valibot";
import { describe, expect, it } from "vitest";

import {
	BattleSchema,
	CursorSchema,
	EligibleBattleTimeSchema,
	TargetsEnvSchema,
	TokenEnvSchema,
} from "@/schema.ts";
import { rawBattle, rawCard, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

describe("BattleSchema", () => {
	it("normalizes a valid battle", () => {
		const result = v.parse(BattleSchema, rawBattle());

		expect(result.battleTime).toBe("2024-01-15T14:30:22.000Z");
		expect(result.team[0]?.tag).toBe("#ABC123");
		expect(result.opponent[0]?.tag).toBe("#DEF456");
	});

	it("adds a leading # only when missing, and always uppercases", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ tag: "#already-hashed" })] })
		);

		expect(result.team[0]?.tag).toBe("#ALREADY-HASHED");
	});

	it("defaults kingTowerHitPoints to 0 and pads princessTowersHitPoints to a 2-tuple", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ princessTowersHitPoints: [1000] })] })
		);

		expect(result.team[0]?.kingTowerHitPoints).toBe(0);
		expect(result.team[0]?.princessTowersHitPoints).toEqual([1000, 0]);
	});

	it("defaults princessTowersHitPoints to [0, 0] when absent", () => {
		const result = v.parse(BattleSchema, rawBattle());

		expect(result.team[0]?.princessTowersHitPoints).toEqual([0, 0]);
	});

	it("falls back an unknown evolutionLevel to undefined instead of failing", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ cards: [rawCard({ evolutionLevel: 99 })] })] })
		);

		expect(result.team[0]?.cards[0]?.evolutionLevel).toBeUndefined();
	});

	it("keeps a known evolutionLevel", () => {
		const result = v.parse(
			BattleSchema,
			rawBattle({ team: [rawPlayer({ cards: [rawCard({ evolutionLevel: 1 })] })] })
		);

		expect(result.team[0]?.cards[0]?.evolutionLevel).toBe(1);
	});

	it("rejects an invalid battleTime", () => {
		const result = v.safeParse(BattleSchema, rawBattle({ battleTime: "not-a-date" }));

		expect(result.success).toBe(false);
	});
});

describe("CursorSchema", () => {
	it("normalizes a valid cursor timestamp", () => {
		expect(v.parse(CursorSchema, "20240115T143022.000Z")).toBe("2024-01-15T14:30:22.000Z");
	});

	it("is idempotent on an already-normalized timestamp", () => {
		expect(v.parse(CursorSchema, "2024-01-15T14:30:22.000Z")).toBe("2024-01-15T14:30:22.000Z");
	});

	it("rejects a garbage cursor value", () => {
		expect(v.safeParse(CursorSchema, "garbage").success).toBe(false);
	});
});

describe("EligibleBattleTimeSchema", () => {
	it("extracts the normalized battleTime from a 1v1 entry", () => {
		expect(v.parse(EligibleBattleTimeSchema, rawBattle())).toBe("2024-01-15T14:30:22.000Z");
	});

	it("falls back to an empty string for a 2v2 entry", () => {
		expect(v.parse(EligibleBattleTimeSchema, rawBattle({ team: [rawPlayer(), rawPlayer()] }))).toBe(
			""
		);
	});

	it("falls back to an empty string for a malformed entry", () => {
		expect(
			v.parse(EligibleBattleTimeSchema, { battleTime: "not-a-date", team: [rawPlayer()] })
		).toBe("");
	});
});

describe("TokenEnvSchema", () => {
	it("accepts a non-empty string", () => {
		expect(v.safeParse(TokenEnvSchema, "some-token").success).toBe(true);
	});

	it("rejects an empty string", () => {
		expect(v.safeParse(TokenEnvSchema, "").success).toBe(false);
	});

	it("rejects undefined", () => {
		expect(v.safeParse(TokenEnvSchema, undefined).success).toBe(false);
	});
});

describe("TargetsEnvSchema", () => {
	it("parses and normalizes a valid TARGETS JSON array", () => {
		const raw = JSON.stringify([{ tag: "abc", webhook: WEBHOOK }]);

		const result = v.parse(TargetsEnvSchema, raw);

		expect(result).toEqual([{ tag: "#ABC", webhook: WEBHOOK }]);
	});

	it("rejects malformed JSON", () => {
		expect(v.safeParse(TargetsEnvSchema, "{not json").success).toBe(false);
	});

	it("rejects a non-array JSON value", () => {
		expect(v.safeParse(TargetsEnvSchema, JSON.stringify({ tag: "abc" })).success).toBe(false);
	});

	it("rejects an entry with a non-URL webhook", () => {
		const raw = JSON.stringify([{ tag: "abc", webhook: "not-a-url" }]);

		expect(v.safeParse(TargetsEnvSchema, raw).success).toBe(false);
	});
});
