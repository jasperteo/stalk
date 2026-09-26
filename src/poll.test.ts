/**
 * @module
 *
 * Tests for `poll.ts`, run against a real in-memory Deno KV store, with a stubbed `fetch` for the
 * battle log and a mocked `notifyBattle`. They cover each poll outcome, the delivery rules (seed on
 * first run, write only after a successful post), and the tick-wide rules in `pollAll`: one KV read
 * per tick, and no rejection.
 */

import { describe, expect, test, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import type { Target } from "@/schema.ts";
import { driftedBattle, rawBattle, WEBHOOK } from "@/testing/fixtures.ts";
import { spyMemoryKv } from "@/testing/kv.ts";

vi.mock(import("@/discord.ts"), () => ({ notifyBattle: vi.fn<typeof notifyBattle>() }));
vi.mock(import("@/log.ts"));

const TAG = "#ABC123";
const TARGET: Target = { tag: TAG, webhook: WEBHOOK };
const TOKEN = "test-token";

/** Targets that share one webhook. The fan-out tests only vary the tags. */
function targetsFor(...tags: string[]): Target[] {
	return tags.map((tag) => ({ tag, webhook: WEBHOOK }));
}

/** A `fetch` stub that answers every request with the same battle log. */
function battlelogFetch(entries: unknown[]) {
	return vi.fn(() => Promise.resolve(Response.json(entries)));
}

/**
 * Points `Deno.openKv` at a fresh in-memory store (see `spyMemoryKv`), then resets the module
 * registry and imports `poll.ts`, so its top-level `await Deno.openKv()` opens that store.
 *
 * `tick` runs `pollAll` for a single target. Going through `pollAll`, the real tick entry point,
 * means each call reads lastBattle from KV exactly as production does, so a test can run several
 * polls in a row without passing values between them.
 *
 * `log` comes from the same fresh import. `vi.resetModules()` re-evaluates the `@/log.ts` mock, and
 * a statically imported `log` would be a different instance from the one `poll.ts` writes to.
 */
async function importPoll() {
	const getKv = spyMemoryKv();

	vi.resetModules();
	const { listLastBattles, pollAll } = await import("@/poll.ts");
	const { log } = await import("@/log.ts");

	const tick = async (target: Target = TARGET) => {
		const outcomes = await pollAll([target], TOKEN);
		return outcomes[0];
	};

	return { pollAll, tick, listLastBattles, log, kv: getKv() };
}

describe("poll", () => {
	test("seeds lastBattle on first run without notifying", async () => {
		const { tick, listLastBattles } = await importPoll();
		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		expect(await tick()).toBe("seeded");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-01T00:00:00.000Z"]]));
	});

	test("posts and advances lastBattle on a new battle after the first run", async () => {
		const { tick, listLastBattles } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await tick()).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
	});

	test("leaves lastBattle untouched when the post fails, then retries next poll", async () => {
		const { tick, listLastBattles } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		vi.mocked(notifyBattle).mockRejectedValueOnce(new Error("webhook down"));
		expect(await tick()).toBe("failed");

		// The post failed, so the battle has not been delivered and lastBattle must not move.
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-01T00:00:00.000Z"]]));

		// The next poll posts the same battle and only then advances lastBattle.
		expect(await tick()).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(2);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
	});

	test("prefers a duplicate post over a lost battle when the lastBattle write fails", async () => {
		const { tick, listLastBattles, kv } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		vi.spyOn(kv, "set").mockRejectedValueOnce(new Error("kv write failed"));
		expect(await tick()).toBe("failed");

		// The post went out, but the write failed, so lastBattle still holds the older battle.
		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-01T00:00:00.000Z"]]));

		// The next poll posts the battle a second time, and this time lastBattle advances.
		expect(await tick()).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(2);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
	});

	test("writes lastBattle with a 30-day TTL on both seed and post", async () => {
		const { tick, kv } = await importPoll();
		const setSpy = vi.spyOn(kv, "set");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		// The seed write needs the TTL as well. Without it, a player seeded and then removed from
		// TARGETS would leave an entry that never expires.
		expect(setSpy).toHaveBeenCalledWith(["lastBattle", TAG], "2024-01-01T00:00:00.000Z", {
			expireIn: 2_592_000_000,
		});

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();

		expect(setSpy).toHaveBeenCalledWith(["lastBattle", TAG], "2024-01-15T14:30:22.000Z", {
			expireIn: 2_592_000_000,
		});
	});

	test("skips a repeat poll reporting the same battleTime", async () => {
		const { tick } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();
		expect(await tick()).toBe("skipped");

		expect(notifyBattle).toHaveBeenCalledTimes(1);
	});

	// This case only happens if the battle log stops arriving newest first.
	test("skips an eligible battle older than the stored lastBattle, without rewinding it", async () => {
		const { tick, listLastBattles, log } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		expect(await tick()).toBe("skipped");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
		// Unlike an ordinary skip, this one warns. Without the warning it would look the same as a
		// player who is not playing.
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("predates the stored lastBattle")
		);
	});

	test("skips without writing lastBattle when there is no eligible battle", async () => {
		const { tick, listLastBattles } = await importPoll();
		vi.stubGlobal("fetch", battlelogFetch([]));

		expect(await tick()).toBe("skipped");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map());
	});

	test("reports drift without notifying or writing lastBattle when the newest eligible entry fails schema validation", async () => {
		const { tick, listLastBattles } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([driftedBattle()]));

		expect(await tick()).toBe("drifted");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map());
	});

	test("re-seeds without throwing when the stored lastBattle value is corrupt", async () => {
		const { tick, listLastBattles, kv, log } = await importPoll();
		await kv.set(["lastBattle", TAG], "garbage-cursor");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await tick()).toBe("seeded");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
		// A corrupt value warns. An absent one re-seeds quietly, as the next test checks.
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Corrupt lastBattle value"));
	});

	test("re-seeds silently when the stored lastBattle value is simply absent", async () => {
		const { tick, log } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await tick()).toBe("seeded");

		// A first run and an expired entry look the same, and both are normal, so neither warns.
		expect(log.warn).not.toHaveBeenCalled();
	});

	test("leaves lastBattle untouched when the CR API request fails", async () => {
		const { tick, listLastBattles } = await importPoll();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })))
		);

		expect(await tick()).toBe("failed");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map());
	});

	test("keeps lastBattle entries namespaced per tag in a shared KV", async () => {
		const { tick, listLastBattles } = await importPoll();
		const TAG_B = "#XYZ789";

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240102T000000.000Z" })]));
		await tick({ tag: TAG_B, webhook: WEBHOOK });

		expect(await listLastBattles()).toEqual(
			new Map([
				[TAG, "2024-01-01T00:00:00.000Z"],
				[TAG_B, "2024-01-02T00:00:00.000Z"],
			])
		);
	});
});

describe("pollAll", () => {
	// KV read units are the free tier's scarcest quota, so a tick must cost one read no matter how
	// many players it polls. A `kv.get` per player would produce the same outcomes, so only this test
	// would catch it.
	test("reads every lastBattle in one KV command regardless of target count", async () => {
		const { pollAll, kv } = await importPoll();
		const listSpy = vi.spyOn(kv, "list");
		const getSpy = vi.spyOn(kv, "get");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		const targets = targetsFor("#AAA111", "#BBB222", "#CCC333");

		expect(await pollAll(targets, TOKEN)).toEqual(["seeded", "seeded", "seeded"]);

		expect(listSpy).toHaveBeenCalledTimes(1);
		expect(getSpy).not.toHaveBeenCalled();
	});

	test("one target's failure doesn't reject the tick", async () => {
		const { pollAll } = await importPoll();

		// Every request returns 500, so every poll fails, and `pollAll` still resolves.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("down", { status: 500 })))
		);

		const targets = targetsFor("#AAA111", "#BBB222");

		await expect(pollAll(targets, TOKEN)).resolves.toEqual(["failed", "failed"]);
	});

	// The lastBattle read happens before any poll runs, outside `poll`'s own error handling, and a
	// failure affects every target at once.
	test("reports every target failed when the lastBattle read fails, without seeding any lastBattle", async () => {
		const { pollAll, listLastBattles, kv, log } = await importPoll();

		vi.spyOn(kv, "list").mockImplementationOnce(() => {
			throw new Error("kv unavailable");
		});

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		const targets = targetsFor("#AAA111", "#BBB222");

		await expect(pollAll(targets, TOKEN)).resolves.toEqual(["failed", "failed"]);

		// Nobody was posted to, and nobody was seeded past their newest battle.
		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map());
		expect(log.error).toHaveBeenCalled();
	});
});
