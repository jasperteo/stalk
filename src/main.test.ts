import { beforeEach, describe, expect, test, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import { TARGETS_VAR, TOKEN_VAR } from "@/env.ts";
import { driftedBattle, rawBattle, WEBHOOK } from "@/testing/fixtures.ts";
import { spyMemoryKv } from "@/testing/kv.ts";

vi.mock(import("@/discord.ts"), () => ({ notifyBattle: vi.fn<typeof notifyBattle>() }));
vi.mock(import("@/log.ts"));

const TAG = "#ABC123";

// Common happy-path env for every test (`unstubEnvs` restores between tests); the missing-token
// test re-stubs inside its own body.
beforeEach(() => {
	vi.stubEnv(TOKEN_VAR, "test-token");
	vi.stubEnv(TARGETS_VAR, JSON.stringify([{ tag: TAG, webhook: WEBHOOK }]));
});

type CronHandler = () => Promise<void> | void;

// Deno.ServeHandler also takes a ServeHandlerInfo, which the tests have no use for; typing the
// captured handler by what they actually call keeps `app.fetch(request)` a one-argument call.
type FetchHandler = (request: Request) => Promise<Response>;

type ServeOptions = { handler: FetchHandler; onListen?: (addr: Deno.NetAddr) => void };

/** A stand-in bound address to hand `onListen`, which never inspects more than these two fields. */
const LOCAL_ADDR: Deno.NetAddr = { transport: "tcp", hostname: "localhost", port: 8000 };

/**
 * Serves a distinct battle log per player tag, dispatching on the encoded tag in the request URL; a
 * tag with no entry gets a 500, standing in for that player's API being down.
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
 * Spies `Deno.openKv` (via `spyMemoryKv`, redirecting to a fresh isolated `:memory:` store),
 * `Deno.cron` (capturing its handler instead of really scheduling it), and `Deno.serve` (capturing
 * its handler instead of really binding a port; every import would otherwise fight over the same
 * one). It then resets the module registry and freshly imports `main.ts` so its top-level `await
 * Deno.openKv()`/`Deno.cron(...)`/`Deno.serve(...)` side effects run against our spies.
 *
 * `announceListen` invokes the captured `onListen` callback, which in production fires once per
 * isolate, i.e. once per cron tick on Deploy. `log` comes back too because `vi.resetModules()`
 * re-evaluates the manual `@/log.ts` mock, handing out a fresh `log` each time: a statically
 * imported one would be a stale instance main.ts is no longer bound to.
 */
async function importMain() {
	const getKv = spyMemoryKv();

	let cronHandler: CronHandler | undefined;

	// `Deno.cron` is overloaded (with and without an options argument), and `mockImplementation`
	// types its parameters against the options overload. So capture positionally-untyped rest args
	// and take the handler from the end, where every overload puts it.
	vi.spyOn(Deno, "cron").mockImplementation((...args: unknown[]) => {
		cronHandler = args.at(-1) as CronHandler;
		return Promise.resolve();
	});

	let serveOptions: ServeOptions | undefined;

	// `Deno.serve` is overloaded like `Deno.cron`, so capture positionally-untyped rest args; main.ts
	// always calls the option-bag form. The returned handle is unused, so a stub suffices.
	vi.spyOn(Deno, "serve").mockImplementation((...args: unknown[]) => {
		[serveOptions] = args as [ServeOptions];
		return { shutdown: () => Promise.resolve() } as unknown as Deno.HttpServer<Deno.NetAddr>;
	});

	vi.resetModules();
	await import("@/main.ts");
	const { log } = await import("@/log.ts");

	if (cronHandler === undefined) throw new Error("Deno.cron handler was never captured");
	if (serveOptions === undefined) throw new Error("Deno.serve options were never captured");
	const { handler, onListen } = serveOptions;
	if (onListen === undefined) throw new Error("Deno.serve was given no onListen callback");
	getKv(); // throws if the spy never captured a KV handle

	return {
		app: { fetch: handler },
		tick: cronHandler,
		announceListen: () => {
			onListen(LOCAL_ADDR);
		},
		log,
	};
}

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

	test("announces the tracked target count when the listener binds", async () => {
		const { announceListen, log } = await importMain();

		announceListen();

		// The one line a healthy deploy prints every tick, so it has to name the bound address and say
		// how many players are being tracked.
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("http://localhost:8000"));
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("tracking 1 target(s)"));
	});

	test("skips the tick with a heartbeat when CR_API_TOKEN is unset", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);

		const { tick, announceListen, log } = await importMain();

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		// A misconfigured deploy must be loud in both places it can be: the skipped tick itself, and
		// the listen banner that would otherwise claim it is tracking players.
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

		// The first tick seeds every target from the env-parsed TARGETS list, notifying nobody.
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

		// poll() runs concurrently, so assert the set of webhooks notified rather than call order.
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

		// TAG_B is omitted from the router, so its fetch 500s, standing in for that player's API being
		// down, while TAG gets a new battle to post.
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

		// The whole tally, not fragments of it: the badge colors are identity functions under the log
		// mock, so the line is exact. This also pins that every POLL_OUTCOMES entry is reported (at 0
		// when unused) and in the declared order.
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

		// Drift is its own column, not folded into `skipped`. The two seeded targets are what a quiet
		// tick looks like, and TAG_C must not be counted among them.
		expect(log.info).toHaveBeenCalledWith(
			"poll-battlelogs: 3 targets — posted 0, seeded 2, skipped 0, drifted 1, failed 0"
		);
	});
});
