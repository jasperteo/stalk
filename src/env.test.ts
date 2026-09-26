/**
 * @module
 *
 * Tests for `env.ts`. The module reads the environment once, when it is evaluated, so every test
 * stubs the env vars and then imports a fresh copy through {@link importEnv}.
 */

import { describe, expect, test, vi } from "vitest";

import { TARGETS_VAR, TOKEN_VAR } from "@/env.ts";
import { WEBHOOK } from "@/testing/fixtures.ts";

vi.mock(import("@/log.ts"));

// `vi.stubEnv` writes to `process.env`, which Deno's Node compatibility layer backs with the real
// environment, so `Deno.env.get` in `env.ts` sees the stub. Stubbing a var to `undefined` deletes it,
// and `unstubEnvs` in `vitest.config.ts` restores every var before the next test.

/**
 * Resets the module registry and imports `env.ts` again, so it reads the env vars as the test
 * stubbed them. The reset also re-evaluates the `@/log.ts` mock, so `log` has to come from the same
 * fresh import to be the instance `env.ts` wrote to.
 */
async function importEnv() {
	vi.resetModules();
	const mod = await import("@/env.ts");
	const { log } = await import("@/log.ts");

	return { ...mod, log };
}

describe("config", () => {
	test("is undefined when CR_API_TOKEN is missing", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config, log } = await importEnv();

		expect(config).toBeUndefined();
		// An unset var logs at info level and never at error level.
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining(TOKEN_VAR));
		expect(log.error).not.toHaveBeenCalled();
	});

	test("defaults targets to [] when TARGETS is missing, without reporting an error", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config, log } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
		expect(log.info).toHaveBeenCalledWith(expect.stringContaining(TARGETS_VAR));
		expect(log.error).not.toHaveBeenCalled();
	});

	test("still reports an empty CR_API_TOKEN as an error, unlike an unset one", async () => {
		// An empty string is a value someone set, and `TokenEnvSchema` rejects it, so it counts as
		// invalid rather than unset.
		vi.stubEnv(TOKEN_VAR, "");
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config, log } = await importEnv();

		expect(config).toBeUndefined();
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining(TOKEN_VAR), expect.anything());
	});

	test("parses and normalizes a valid TARGETS value", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, JSON.stringify([{ tag: "abc", webhook: WEBHOOK }]));

		const { config } = await importEnv();

		expect(config).toEqual({
			token: "my-token",
			targets: [{ tag: "#ABC", webhook: WEBHOOK }],
		});
	});

	test("falls back to [] and logs once when TARGETS is malformed JSON", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, "{not json");

		const { config, log } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
		// Exactly one error line, for TARGETS. A second one would mean the valid token was reported
		// as well.
		expect(log.error).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining(TARGETS_VAR),
			expect.anything()
		);
	});
});
