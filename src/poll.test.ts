import { describe, expect, test, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import type { Target } from "@/schema.ts";
import { driftedBattle, rawBattle, WEBHOOK } from "@/testing/fixtures.ts";
import { spyMemoryKv } from "@/testing/kv.ts";

vi.mock("@/discord.ts", () => ({ notifyBattle: vi.fn() }));
vi.mock("@/log.ts");

const TAG = "#ABC123";
const TARGET: Target = { tag: TAG, webhook: WEBHOOK };
const TOKEN = "test-token";

function battlelogFetch(entries: unknown[]) {
	return vi.fn(() => Promise.resolve(Response.json(entries)));
}

/**
 * Spies `Deno.openKv` (via `spyMemoryKv`, redirecting to a fresh isolated `:memory:` store), then
 * resets the module registry and freshly imports `poll.ts` so its top-level `await Deno.openKv()`
 * runs against the spy.
 */
async function importPoll() {
	const getKv = spyMemoryKv();

	vi.resetModules();
	const { listCursors, poll } = await import("@/poll.ts");

	return { poll, listCursors, kv: getKv() };
}

describe("poll", () => {
	test("seeds the cursor on first run without notifying", async () => {
		const { poll, listCursors } = await importPoll();
		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		expect(await poll(TARGET, TOKEN)).toBe("seeded");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-01T00:00:00.000Z" });
	});

	test("posts and advances the cursor on a new battle after the first run", async () => {
		const { poll, listCursors } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await poll(TARGET, TOKEN)).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-15T14:30:22.000Z" });
	});

	test("leaves the cursor untouched when the post fails, then retries next poll", async () => {
		const { poll, listCursors } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		vi.mocked(notifyBattle).mockRejectedValueOnce(new Error("webhook down"));
		expect(await poll(TARGET, TOKEN)).toBe("failed");

		// The failed post must not advance the cursor — the battle is still owed.
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-01T00:00:00.000Z" });

		// The retry posts the same battle and only then advances the cursor.
		expect(await poll(TARGET, TOKEN)).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(2);
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-15T14:30:22.000Z" });
	});

	test("prefers a duplicate post over a lost battle when the cursor write fails", async () => {
		const { poll, listCursors, kv } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		vi.spyOn(kv, "set").mockRejectedValueOnce(new Error("kv write failed"));
		expect(await poll(TARGET, TOKEN)).toBe("failed");

		// The post happened, but the failed write leaves the old cursor — the battle is not marked done.
		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-01T00:00:00.000Z" });

		// At-least-once: the same battle posts again (a duplicate), then the cursor finally advances.
		expect(await poll(TARGET, TOKEN)).toBe("posted");

		expect(notifyBattle).toHaveBeenCalledTimes(2);
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-15T14:30:22.000Z" });
	});

	test("writes the cursor with a 30-day TTL on both seed and post", async () => {
		const { poll, kv } = await importPoll();
		const setSpy = vi.spyOn(kv, "set");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		// Seed write (first run) must already carry the TTL, or a seeded-then-removed
		// player's cursor would be the one entry that never expires.
		expect(setSpy).toHaveBeenCalledWith(["lastBattle", TAG], "2024-01-01T00:00:00.000Z", {
			expireIn: 2_592_000_000,
		});

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await poll(TARGET, TOKEN);

		expect(setSpy).toHaveBeenCalledWith(["lastBattle", TAG], "2024-01-15T14:30:22.000Z", {
			expireIn: 2_592_000_000,
		});
	});

	test("skips a repeat poll reporting the same battleTime", async () => {
		const { poll } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await poll(TARGET, TOKEN);
		expect(await poll(TARGET, TOKEN)).toBe("skipped");

		expect(notifyBattle).toHaveBeenCalledTimes(1);
	});

	test("skips without writing a cursor when there is no eligible battle", async () => {
		const { poll, listCursors } = await importPoll();
		vi.stubGlobal("fetch", battlelogFetch([]));

		expect(await poll(TARGET, TOKEN)).toBe("skipped");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listCursors()).toEqual({});
	});

	test("reports drift without notifying or writing a cursor when the newest eligible entry fails schema validation", async () => {
		const { poll, listCursors } = await importPoll();

		vi.stubGlobal("fetch", battlelogFetch([driftedBattle()]));

		expect(await poll(TARGET, TOKEN)).toBe("drifted");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listCursors()).toEqual({});
	});

	test("re-seeds without throwing when the stored cursor is corrupt", async () => {
		const { poll, listCursors, kv } = await importPoll();
		await kv.set(["lastBattle", TAG], "garbage-cursor");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		expect(await poll(TARGET, TOKEN)).toBe("seeded");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listCursors()).toEqual({ [TAG]: "2024-01-15T14:30:22.000Z" });
	});

	test("leaves the cursor untouched when the CR API request fails", async () => {
		const { poll, listCursors } = await importPoll();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })))
		);

		expect(await poll(TARGET, TOKEN)).toBe("failed");

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await listCursors()).toEqual({});
	});

	test("keeps cursors namespaced per tag in a shared KV", async () => {
		const { poll, listCursors } = await importPoll();
		const TAG_B = "#XYZ789";

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await poll(TARGET, TOKEN);

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240102T000000.000Z" })]));
		await poll({ tag: TAG_B, webhook: WEBHOOK }, TOKEN);

		expect(await listCursors()).toEqual({
			[TAG]: "2024-01-01T00:00:00.000Z",
			[TAG_B]: "2024-01-02T00:00:00.000Z",
		});
	});
});
