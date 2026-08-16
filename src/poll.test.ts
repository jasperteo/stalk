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

/** Targets sharing one webhook — only the tags vary in the fan-out tests. */
function targetsFor(...tags: string[]): Target[] {
	return tags.map((tag) => ({ tag, webhook: WEBHOOK }));
}

function battlelogFetch(entries: unknown[]) {
	return vi.fn(() => Promise.resolve(Response.json(entries)));
}

/**
 * Spies `Deno.openKv` (via `spyMemoryKv`, redirecting to a fresh isolated `:memory:` store), then
 * resets the module registry and freshly imports `poll.ts` so its top-level `await Deno.openKv()`
 * runs against the spy.
 *
 * Returns `tick`, a one-target `pollAll` — the tests drive the real tick entry point rather than
 * `poll` (which is module-private now), so each call re-reads lastBattle exactly as production does
 * and sequences of polls need no lastBattle plumbing.
 *
 * `log` comes back with it because `vi.resetModules()` re-evaluates the manual `@/log.ts` mock,
 * handing out a fresh `log` each time: a statically imported one would be a stale instance poll.ts
 * is no longer bound to.
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

		// The failed post must not advance lastBattle — the battle is still owed.
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-01T00:00:00.000Z"]]));

		// The retry posts the same battle and only then advances lastBattle.
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

		// The post happened, but the failed write leaves the old lastBattle — the battle is not marked
		// done.
		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-01T00:00:00.000Z"]]));

		// At-least-once: the same battle posts again (a duplicate), then lastBattle finally advances.
		expect(await tick()).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(2);
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
	});

	test("writes lastBattle with a 30-day TTL on both seed and post", async () => {
		const { tick, kv } = await importPoll();
		const setSpy = vi.spyOn(kv, "set");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		// Seed write (first run) must already carry the TTL, or a seeded-then-removed
		// player's lastBattle would be the one entry that never expires.
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

	// Only reachable if the battlelog's newest-first order breaks — see the guard in poll.ts.
	test("skips an eligible battle older than the stored lastBattle, without rewinding it", async () => {
		const { tick, listLastBattles, log } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		expect(await tick()).toBe("skipped");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map([[TAG, "2024-01-15T14:30:22.000Z"]]));
		// Loud, unlike an ordinary skip: a quiet `skipped` here would be indistinguishable from a
		// player who simply isn't playing, which is exactly the signal we'd need to notice.
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
		// A corrupt value is the loud case; an absent/expired one re-seeds silently (below).
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Corrupt lastBattle value"));
	});

	test("re-seeds silently when the stored lastBattle value is simply absent", async () => {
		const { tick, log } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await tick()).toBe("seeded");

		// First run and an expired entry are indistinguishable and both normal, so neither may warn —
		// `readLastBattle` skips the parse entirely on `undefined` to keep that check exact.
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
	// The whole reason poll() takes its lastBattle value as an argument. KV reads are the free tier's
	// binding limit, so a tick's read cost has to be flat in the number of targets — a regression to a
	// per-player kv.get would be invisible in every other test here, since the outcomes are identical.
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

		// Every fetch 500s, so all three polls fail — pollAll must still resolve, not reject.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("down", { status: 500 })))
		);

		const targets = targetsFor("#AAA111", "#BBB222");

		await expect(pollAll(targets, TOKEN)).resolves.toEqual(["failed", "failed"]);
	});

	// The lastBattle read runs before any poll(), so it is the one failure that isn't already
	// contained by poll()'s own catch — and it hits every target at once. It must not reject the tick.
	test("reports every target failed when the lastBattle read fails, without seeding any lastBattle", async () => {
		const { pollAll, listLastBattles, kv, log } = await importPoll();

		vi.spyOn(kv, "list").mockImplementationOnce(() => {
			throw new Error("kv unavailable");
		});

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		const targets = targetsFor("#AAA111", "#BBB222");

		await expect(pollAll(targets, TOKEN)).resolves.toEqual(["failed", "failed"]);

		// Nothing posted, and no lastBattle was seeded past anyone's newest battle.
		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listLastBattles()).toEqual(new Map());
		expect(log.error).toHaveBeenCalled();
	});
});
