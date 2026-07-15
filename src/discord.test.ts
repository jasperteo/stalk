import * as v from "@valibot/valibot";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderDeckGrid } from "@/deck-image.ts";
import { notifyBattle } from "@/discord.ts";
import { log } from "@/log.ts";
import { BattleSchema } from "@/schema.ts";
import type { Battle } from "@/schema.ts";
import { BOB, rawBattle, rawPlayer, WEBHOOK } from "@/testing/fixtures.ts";

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
	embeds: { fields?: { name: string; value: string }[] }[];
};

/** The decoded `payload_json` of the first webhook POST. */
function sentPayload(form: FormData = sentForm()): Payload {
	return parseJsonString(form.get("payload_json")) as Payload;
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
});
