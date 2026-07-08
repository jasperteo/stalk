import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// No test in this suite uses `.concurrent`: several tests mutate real shared
		// `globalThis` state (Deno.openKv/Deno.cron spies, stubbed fetch), which concurrent
		// tests within a file would race on regardless of the settings below.
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
		// `restoreMocks` only restores `vi.spyOn` originals; `clearMocks` also wipes call history on
		// the `vi.fn()` instances created inside `vi.mock` factories/manual mocks, which the discord
		// and main tests assert call counts on across tests.
		clearMocks: true,
		// Vitest already auto-disables watch mode under CI / non-interactive shells;
		// no need to hardcode `watch: false` here.
	},
	resolve: { tsconfigPaths: true },
});
