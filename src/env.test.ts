import { describe, expect, it, vi } from "vitest";

import { TARGETS_VAR, TOKEN_VAR } from "@/env.ts";
import { WEBHOOK } from "@/testing/fixtures.ts";

vi.mock("@/log.ts");

// `vi.stubEnv` mutates `process.env`, which Deno's node-compat live-backs with the real env — so
// env.ts's `Deno.env.get` sees the stub, and `unstubEnvs` in vitest.config.ts restores the
// original values before each test (stubbing to `undefined` deletes the variable).
//
// `env.ts` reads `Deno.env` once at module top level; resetting modules before each fresh dynamic
// import gives every scenario its own clean module evaluation. The manual log mock is re-evaluated
// along with it, so `log` must come from the same fresh registry env.ts saw.
async function importEnv() {
	vi.resetModules();
	const mod = await import("@/env.ts");
	const { log } = await import("@/log.ts");

	return { ...mod, log };
}

describe("config", () => {
	it("is undefined when CR_API_TOKEN is missing", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config, log } = await importEnv();

		expect(config).toBeUndefined();
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining(TOKEN_VAR), expect.anything());
	});

	it("defaults targets to [] when TARGETS is missing", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
	});

	it("parses and normalizes a valid TARGETS value", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, JSON.stringify([{ tag: "abc", webhook: WEBHOOK }]));

		const { config } = await importEnv();

		expect(config).toEqual({
			token: "my-token",
			targets: [{ tag: "#ABC", webhook: WEBHOOK }],
		});
	});

	it("falls back to [] and logs once when TARGETS is malformed JSON", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, "{not json");

		const { config, log } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith(expect.stringContaining(TARGETS_VAR), expect.anything());
	});
});
