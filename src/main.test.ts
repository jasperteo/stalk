/**
 * @module
 *
 * Tests for `main.ts`, the wiring: the HTTP routes, the cron registration, the listen banner, and
 * the per-tick tally. `Deno.serve`, `Deno.cron` and `Deno.openKv` are spied so importing `main.ts`
 * binds no port and schedules nothing, and each test drives the captured handlers directly.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import { TARGETS_VAR, TOKEN_VAR } from "@/env.ts";
import { driftedBattle, rawBattle, WEBHOOK } from "@/testing/fixtures.ts";
import { spyMemoryKv } from "@/testing/kv.ts";

vi.mock(import("@/discord.ts"), () => ({ notifyBattle: vi.fn<typeof notifyBattle>() }));
vi.mock(import("@/log.ts"));

const TAG = "#ABC123";

// A valid config with one target. `unstubEnvs` clears it after each test, and a test that needs a
// different config stubs over it in its own body.
beforeEach(() => {
	vi.stubEnv(TOKEN_VAR, "test-token");
	vi.stubEnv(TARGETS_VAR, JSON.stringify([{ tag: TAG, webhook: WEBHOOK }]));
});

type CronHandler = () => Promise<void> | void;

// `Deno.ServeHandler` also receives a `ServeHandlerInfo`, which no test uses. Typing the captured
// handler as a one-argument function lets the tests call `app.fetch(request)`.
type FetchHandler = (request: Request) => Promise<Response>;

type ServeOptions = { handler: FetchHandler; onListen?: (addr: Deno.NetAddr) => void };

/** The address handed to `onListen`. `main.ts` reads only `hostname` and `port` from it. */
const LOCAL_ADDR: Deno.NetAddr = { transport: "tcp", hostname: "localhost", port: 8000 };

/**
 * A `fetch` stub that serves a different battle log per player, matching the URL-encoded tag in the
 * request URL. A tag with no entry gets a 500, as if that player's API request failed.
 */
function battlelogFetchByTag(logs: Record<string, unknown[]>) {
	return vi.fn<(input: string | URL | Request) => Promise<Response>>((input) => {
		const url = String(input instanceof Request ? input.url : input);
		const tag = Object.keys(logs).find((key) => url.includes(encodeURIComponent(key)));

		return Promise.resolve(
			tag === undefined ? new Response("down", { status: 500 }) : Response.json(logs[tag])
		);
	});
}

/**
 * Imports a fresh `main.ts` with its side effects captured:
 *
 * - `Deno.openKv` opens an in-memory store (see `spyMemoryKv`).
 * - `Deno.cron` records its arguments and handler instead of scheduling anything.
 * - `Deno.serve` records its options instead of binding a port, which every import would otherwise
 *   try to do on the same one.
 *
 * It returns the Hono app's `fetch`, the cron handler as `tick`, the cron registration arguments,
 * and `announceListen`, which calls the captured `onListen` the way the server does once it
 * listens. `log` comes from the same fresh import, because `vi.resetModules()` re-evaluates the
 * `@/log.ts` mock and a statically imported `log` would not be the instance `main.ts` writes to.
 */
async function importMain() {
	const getKv = spyMemoryKv();

	let cronHandler: CronHandler | undefined;
	let cronArgs: unknown[] | undefined;

	// `Deno.cron` has overloads with and without an options argument, and `mockImplementation` types
	// its parameters from one of them. Taking untyped rest arguments works for both: the handler is
	// always last, and the name and schedule stay available for the registration test.
	vi.spyOn(Deno, "cron").mockImplementation((...args: unknown[]) => {
		cronArgs = args;
		cronHandler = args.at(-1) as CronHandler;
		return Promise.resolve();
	});

	let serveOptions: ServeOptions | undefined;

	// `Deno.serve` is overloaded too. `main.ts` always passes a single options object, and nothing
	// uses the returned server, so a minimal stub stands in for it.
	vi.spyOn(Deno, "serve").mockImplementation((...args: unknown[]) => {
		[serveOptions] = args as [ServeOptions];
		return { shutdown: () => Promise.resolve() } as unknown as Deno.HttpServer<Deno.NetAddr>;
	});

	vi.resetModules();
	await import("@/main.ts");
	const { log } = await import("@/log.ts");

	if (cronHandler === undefined || cronArgs === undefined) {
		throw new Error("Deno.cron was never called");
	}
	if (serveOptions === undefined) throw new Error("Deno.serve options were never captured");
	const { handler, onListen } = serveOptions;
	if (onListen === undefined) throw new Error("Deno.serve was given no onListen callback");
	getKv(); // Throws if `main.ts` never opened KV.

	return {
		app: { fetch: handler },
		tick: cronHandler,
		cronArgs,
		announceListen: () => {
			onListen(LOCAL_ADDR);
		},
		log,
	};
}

/** The `/kv/last-battle` response body. */
async function lastBattles(app: Awaited<ReturnType<typeof importMain>>["app"]) {
	const response = await app.fetch(new Request("http://localhost/kv/last-battle"));
	return (await response.json()) as Record<string, unknown>;
}

describe("main", () => {
	test("responds to the health check", async () => {
		const { app } = await importMain();
		const response = await app.fetch(new Request("http://localhost/"));

		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("registers the poll job under its own name, once a minute", async () => {
		const { cronArgs } = await importMain();

		// The other tests call the captured handler directly, so they would all still pass if the
		// schedule or the job name changed. This is the one test that checks both.
		expect(cronArgs.slice(0, 2)).toEqual(["poll-battlelogs", { minute: { every: 1 } }]);
	});

	test("announces the tracked target count when the listener binds", async () => {
		const { announceListen, log } = await importMain();

		announceListen();

		// On Deno Deploy this line appears about once a tick, so it names the address and the number
		// of tracked players.
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("http://localhost:8000"));
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("tracking 1 target(s)"));
	});

	test("skips the tick with a heartbeat when CR_API_TOKEN is unset", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);

		const { tick, announceListen, log } = await importMain();

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		// Both lines a deploy prints have to show the missing token: the tick's warning, and the
		// listen banner, which says "idle" instead of claiming to track anyone.
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("skipped tick"));

		announceListen();

		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("idle"));
	});
});

describe("main with multiple targets", () => {
	const TAG_B = "#XYZ789";
	const WEBHOOK_B = "https://discord.com/api/webhooks/2/bbb";

	beforeEach(() => {
		vi.stubEnv(
			TARGETS_VAR,
			JSON.stringify([
				{ tag: TAG, webhook: WEBHOOK },
				{ tag: TAG_B, webhook: WEBHOOK_B },
			])
		);
	});

	test("routes each battle to its own target's webhook", async () => {
		const { app, tick } = await importMain();

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240101T000000.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240102T000000.000Z" })],
			})
		);
		await tick();

		// The first tick seeds both targets and posts nothing.
		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattles(app)).toEqual({
			[TAG]: "2024-01-01T00:00:00.000Z",
			[TAG_B]: "2024-01-02T00:00:00.000Z",
		});

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240115T143022.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240116T143022.000Z" })],
			})
		);
		await tick();

		expect(await lastBattles(app)).toEqual({
			[TAG]: "2024-01-15T14:30:22.000Z",
			[TAG_B]: "2024-01-16T14:30:22.000Z",
		});

		// The polls run concurrently, so compare the set of webhooks, not the call order.
		const notifiedWebhooks = new Set(
			vi.mocked(notifyBattle).mock.calls.map(([webhook]) => webhook)
		);
		expect(notifiedWebhooks).toEqual(new Set([WEBHOOK, WEBHOOK_B]));
	});

	test("one target's API failure doesn't sink the others, and logs a per-tick tally covering every target", async () => {
		const { app, tick, log } = await importMain();

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240101T000000.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240102T000000.000Z" })],
			})
		);
		await tick();

		// TAG gets a new battle. TAG_B has no entry, so its request returns 500.
		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240115T143022.000Z" })],
			})
		);
		await tick();

		expect(vi.mocked(notifyBattle).mock.calls.map(([webhook]) => webhook)).toContain(WEBHOOK);
		expect(await lastBattles(app)).toEqual({
			[TAG]: "2024-01-15T14:30:22.000Z",
			[TAG_B]: "2024-01-02T00:00:00.000Z",
		});

		// The mocked colors are identity functions, so the whole line can be compared exactly. That
		// also checks that every outcome appears, zeros included, in `POLL_OUTCOMES` order.
		expect(log.info).toHaveBeenCalledWith(
			"poll-battlelogs: 2 targets — posted 1, seeded 0, skipped 0, drifted 0, failed 1"
		);
	});

	test("a drifted battle shows up as its own tally outcome, not folded into skipped", async () => {
		const TAG_C = "#DEF456";
		const WEBHOOK_C = "https://discord.com/api/webhooks/3/ccc";
		vi.stubEnv(
			TARGETS_VAR,
			JSON.stringify([
				{ tag: TAG, webhook: WEBHOOK },
				{ tag: TAG_B, webhook: WEBHOOK_B },
				{ tag: TAG_C, webhook: WEBHOOK_C },
			])
		);

		const { tick, log } = await importMain();

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240101T000000.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240102T000000.000Z" })],
				[TAG_C]: [driftedBattle()],
			})
		);
		await tick();

		// Two targets seed normally, and the drifted one gets its own count instead of being counted
		// as skipped or seeded.
		expect(log.info).toHaveBeenCalledWith(
			"poll-battlelogs: 3 targets — posted 0, seeded 2, skipped 0, drifted 1, failed 0"
		);
	});
});
