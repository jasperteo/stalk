import { beforeEach, describe, expect, test, vi } from "vitest";

import { notifyBattle } from "@/discord.ts";
import { TARGETS_VAR, TOKEN_VAR } from "@/env.ts";
import { rawBattle, WEBHOOK } from "@/testing/fixtures.ts";
import { spyMemoryKv } from "@/testing/kv.ts";

vi.mock("@/discord.ts", () => ({ notifyBattle: vi.fn() }));
vi.mock("@/log.ts");

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

/**
 * Serves a distinct battle log per player tag, dispatching on the encoded tag in the request URL; a
 * tag with no entry gets a 500, standing in for that player's API being down.
 */
function battlelogFetchByTag(logs: Record<string, unknown[]>) {
	return vi.fn((input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		const tag = Object.keys(logs).find((key) => url.includes(encodeURIComponent(key)));

		return Promise.resolve(
			tag === undefined ? new Response("down", { status: 500 }) : Response.json(logs[tag])
		);
	});
}

/**
 * Spies `Deno.openKv` (via `spyMemoryKv`, redirecting to a fresh isolated `:memory:` store),
 * `Deno.cron` (capturing its handler instead of really scheduling it) and `Deno.serve` (capturing
 * its handler instead of really binding a port — every import would otherwise fight over the same
 * one), then resets the module registry and freshly imports `main.ts` so its top-level `await
 * Deno.openKv()`/`Deno.cron(...)`/`Deno.serve(...)` side effects run against our spies.
 */
async function importMain() {
	const getKv = spyMemoryKv();

	// Pinned rather than assumed: `main.ts` gates a blocking top-level `await quitOnKeypress()` on
	// this, so a runner whose worker inherits a TTY stdin would hang the import instead of failing.
	const isTerminal = vi.spyOn(Deno.stdin, "isTerminal").mockReturnValue(false);

	let cronHandler: CronHandler | undefined;

	// `Deno.cron` is overloaded (with and without an options argument), and `mockImplementation`
	// types its parameters against the options overload — so capture positionally-untyped rest args
	// and take the handler from the end, where every overload puts it.
	vi.spyOn(Deno, "cron").mockImplementation((...args: unknown[]) => {
		cronHandler = args.at(-1) as CronHandler;
		return Promise.resolve();
	});

	let fetchHandler: FetchHandler | undefined;

	// `Deno.serve` is overloaded like `Deno.cron`, so capture positionally-untyped rest args; main.ts
	// always calls the option-bag form. The returned handle only exists for the quit key's
	// `shutdown()`, which never runs here (the `isTerminal` spy above pins stdin as non-terminal),
	// so a stub suffices.
	vi.spyOn(Deno, "serve").mockImplementation((...args: unknown[]) => {
		const [options] = args as [{ handler: FetchHandler }];
		fetchHandler = options.handler;
		return { shutdown: () => Promise.resolve() } as unknown as Deno.HttpServer<Deno.NetAddr>;
	});

	vi.resetModules();
	await import("@/main.ts");

	if (cronHandler === undefined) throw new Error("Deno.cron handler was never captured");
	if (fetchHandler === undefined) throw new Error("Deno.serve handler was never captured");
	getKv(); // throws if the spy never captured a KV handle

	return { app: { fetch: fetchHandler }, tick: cronHandler, isTerminal };
}

async function lastBattleCursors(app: Awaited<ReturnType<typeof importMain>>["app"]) {
	const response = await app.fetch(new Request("http://localhost/kv/last-battle"));
	return (await response.json()) as Record<string, unknown>;
}

describe("main", () => {
	test("responds to the health check", async () => {
		const { app } = await importMain();
		const response = await app.fetch(new Request("http://localhost/"));

		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("skips the tick with a heartbeat when CR_API_TOKEN is unset", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);

		const { tick } = await importMain();

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
	});

	test("does not read stdin when it is not a terminal", async () => {
		const { isTerminal } = await importMain();

		expect(isTerminal).toHaveBeenCalled();
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

	test("polls every target and keeps their cursors namespaced per tag", async () => {
		const { app, tick } = await importMain();
		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240101T000000.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240102T000000.000Z" })],
			})
		);

		await tick();

		expect(notifyBattle).not.toHaveBeenCalled();
		expect(await lastBattleCursors(app)).toEqual({
			[TAG]: "2024-01-01T00:00:00.000Z",
			[TAG_B]: "2024-01-02T00:00:00.000Z",
		});
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

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240115T143022.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240116T143022.000Z" })],
			})
		);
		await tick();

		expect(await lastBattleCursors(app)).toEqual({
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
		const { app, tick } = await importMain();
		// importMain()'s vi.resetModules() re-evaluates the manual `@/log.ts` mock, so it hands out
		// a fresh `log` object each time; re-import it here (no further resetModules in between) to
		// get the exact instance main.ts's freshly re-imported copy is bound to.
		const { log } = await import("@/log.ts");

		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240101T000000.000Z" })],
				[TAG_B]: [rawBattle({ battleTime: "20240102T000000.000Z" })],
			})
		);
		await tick();

		// TAG_B is omitted from the router, so its fetch 500s — standing in for that player's API
		// being down — while TAG gets a new battle to post.
		vi.stubGlobal(
			"fetch",
			battlelogFetchByTag({
				[TAG]: [rawBattle({ battleTime: "20240115T143022.000Z" })],
			})
		);
		await tick();

		expect(vi.mocked(notifyBattle).mock.calls.map(([webhook]) => webhook)).toContain(WEBHOOK);
		expect(await lastBattleCursors(app)).toEqual({
			[TAG]: "2024-01-15T14:30:22.000Z",
			[TAG_B]: "2024-01-02T00:00:00.000Z",
		});

		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("2 targets"));
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("posted 1"));
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining("failed 1"));
	});
});
