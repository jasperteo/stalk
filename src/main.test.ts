import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import { rawBattle } from "@/testing/fixtures.ts";

vi.mock("@/discord.ts", () => ({ notifyBattle: vi.fn() }));
vi.mock("@/log.ts");

const TOKEN_VAR = "CR_API_TOKEN";
const TARGETS_VAR = "TARGETS";
const TAG = "#ABC123";
const WEBHOOK = "https://discord.com/api/webhooks/1/aaa";

// Common happy-path env for every test. `vi.stubEnv` mutates `process.env`, which Deno's
// node-compat live-backs with the real env, so env.ts's `Deno.env.get` sees it; `unstubEnvs` in
// vitest.config.ts restores before each test. The health-check and missing-token tests re-stub
// inside their own bodies.
beforeEach(() => {
	vi.stubEnv(TOKEN_VAR, "test-token");
	vi.stubEnv(TARGETS_VAR, JSON.stringify([{ tag: TAG, webhook: WEBHOOK }]));
});

// Each test's importMain opens a fresh `:memory:` KV that main.ts never closes (production holds
// one handle for the isolate's lifetime); close it here so the tests don't accumulate open KV
// resources for the worker's lifetime.
let openedKv: Deno.Kv | undefined;

afterEach(() => {
	openedKv?.close();
	openedKv = undefined;
});

type CronHandler = () => Promise<void> | void;

function battlelogFetch(entries: unknown[]) {
	return vi.fn(() => Promise.resolve(Response.json(entries)));
}

/**
 * Spies `Deno.openKv` (redirecting to a fresh isolated `:memory:` store, capturing the handle for
 * direct KV manipulation in tests) and `Deno.cron` (capturing its handler instead of really
 * scheduling it), then resets the module registry and freshly imports `main.ts` so its top-level
 * `await Deno.openKv()`/`Deno.cron(...)` side effects run against our spies.
 */
async function importMain() {
	// `restoreMocks` puts the real `Deno.openKv` back before each test, so capturing it here (rather
	// than calling `Deno.openKv` from inside the mock, which would recurse into the spy itself) always
	// grabs the genuine implementation.
	const openKv = Deno.openKv.bind(Deno);

	vi.spyOn(Deno, "openKv").mockImplementation(async () => {
		openedKv = await openKv(":memory:");
		return openedKv;
	});

	let cronHandler: CronHandler | undefined;

	// `Deno.cron` is overloaded (with and without an options argument), and `mockImplementation`
	// types its parameters against the options overload — so capture positionally-untyped rest args
	// and take the handler from the end, where every overload puts it.
	vi.spyOn(Deno, "cron").mockImplementation((...args: unknown[]) => {
		cronHandler = args.at(-1) as CronHandler;
		return Promise.resolve();
	});

	vi.resetModules();
	const { default: appExport } = await import("@/main.ts");

	if (cronHandler === undefined) throw new Error("Deno.cron handler was never captured");
	if (openedKv === undefined) throw new Error("Deno.openKv handle was never captured");

	return { app: appExport, tick: cronHandler, kv: openedKv };
}

async function lastBattleCursors(app: Awaited<ReturnType<typeof importMain>>["app"]) {
	const response = await app.fetch(new Request("http://localhost/kv/last-battle"));
	return (await response.json()) as Record<string, unknown>;
}

describe("main", () => {
	it("responds to the health check", async () => {
		vi.stubEnv(TARGETS_VAR, "[]");

		const { app } = await importMain();
		const response = await app.fetch(new Request("http://localhost/"));

		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("seeds the cursor on first run without notifying", async () => {
		const { app, tick } = await importMain();
		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattleCursors(app)).toEqual({ "#ABC123": "2024-01-01T00:00:00.000Z" });
	});

	it("posts and advances the cursor on a new battle after the first run", async () => {
		const { app, tick } = await importMain();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();

		expect(notifyBattle).toHaveBeenCalledTimes(1);
		expect(await lastBattleCursors(app)).toEqual({ "#ABC123": "2024-01-15T14:30:22.000Z" });
	});

	it("skips a repeat tick reporting the same battleTime", async () => {
		const { tick } = await importMain();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240101T000000.000Z" })]));
		await tick();

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();
		await tick();

		expect(notifyBattle).toHaveBeenCalledTimes(1);
	});

	it("skips without writing a cursor when there is no eligible battle", async () => {
		const { app, tick } = await importMain();
		vi.stubGlobal("fetch", battlelogFetch([]));

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattleCursors(app)).toEqual({});
	});

	it("re-seeds without throwing when the stored cursor is corrupt", async () => {
		const { app, tick, kv } = await importMain();
		await kv.set(["lastBattle", TAG], "garbage-cursor");

		vi.stubGlobal("fetch", battlelogFetch([rawBattle({ battleTime: "20240115T143022.000Z" })]));
		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattleCursors(app)).toEqual({ "#ABC123": "2024-01-15T14:30:22.000Z" });
	});

	it("leaves the cursor untouched when the CR API request fails", async () => {
		const { app, tick } = await importMain();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("server error", { status: 500 })))
		);

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattleCursors(app)).toEqual({});
	});

	it("skips the tick with a heartbeat when CR_API_TOKEN is unset", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);
		vi.stubEnv(TARGETS_VAR, "[]");

		const { tick } = await importMain();
		vi.stubGlobal("fetch", battlelogFetch([]));

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
	});
});
