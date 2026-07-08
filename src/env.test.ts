import { describe, expect, it, vi } from "vitest";

const TOKEN_VAR = "CR_API_TOKEN";
const TARGETS_VAR = "TARGETS";

// `vi.stubEnv` mutates `process.env`, which Deno's node-compat live-backs with the real env — so
// env.ts's `Deno.env.get` sees the stub, and `unstubEnvs` in vitest.config.ts restores the
// original values before each test (stubbing to `undefined` deletes the variable).
//
// `env.ts` reads `Deno.env` once at module top level, and transitively imports `log.ts` (which
// itself binds console methods at import time — see log.test.ts). Resetting modules and spying
// before each fresh dynamic import gives every scenario its own clean module evaluation.
async function importEnv() {
	vi.resetModules();
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const mod = await import("@/env.ts");

	return { ...mod, errorSpy };
}

describe("config", () => {
	it("is undefined when CR_API_TOKEN is missing", async () => {
		vi.stubEnv(TOKEN_VAR, undefined);
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config, errorSpy } = await importEnv();

		expect(config).toBeUndefined();
		expect(errorSpy.mock.calls.some((call) => String(call[1]).includes(TOKEN_VAR))).toBe(true);
	});

	it("is undefined when CR_API_TOKEN is an empty string", async () => {
		vi.stubEnv(TOKEN_VAR, "");
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config } = await importEnv();

		expect(config).toBeUndefined();
	});

	it("defaults targets to [] when TARGETS is missing", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, undefined);

		const { config } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
	});

	it("parses and normalizes a valid TARGETS value", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(
			TARGETS_VAR,
			JSON.stringify([{ tag: "abc", webhook: "https://discord.com/api/webhooks/1/aaa" }])
		);

		const { config } = await importEnv();

		expect(config).toEqual({
			token: "my-token",
			targets: [{ tag: "#ABC", webhook: "https://discord.com/api/webhooks/1/aaa" }],
		});
	});

	it("falls back to [] and logs once when TARGETS is malformed JSON", async () => {
		vi.stubEnv(TOKEN_VAR, "my-token");
		vi.stubEnv(TARGETS_VAR, "{not json");

		const { config, errorSpy } = await importEnv();

		expect(config).toEqual({ token: "my-token", targets: [] });
		expect(errorSpy.mock.calls.some((call) => String(call[1]).includes(TARGETS_VAR))).toBe(true);
	});
});
