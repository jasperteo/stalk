import { defineConfig } from "vitest/config";

const vitestConfig = defineConfig({
	test: {
		// All tests live in src/; scoping discovery there skips walking images/ (180 PNGs) and scripts/.
		dir: "./src",
		environment: "node",
		// No test in this suite uses `.concurrent`: several tests mutate real shared
		// `globalThis` state (Deno.openKv/Deno.cron spies, stubbed fetch), which concurrent
		// tests within a file would race on regardless of the settings below.
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
		// `clearMocks` is not set here because vitest 5 turns it on by default, and the suite needs it:
		// `restoreMocks` alone only restores `vi.spyOn` originals, where `clearMocks` also wipes call
		// history on the `vi.fn()` instances created inside `vi.mock` factories and manual mocks, which
		// the discord and main tests assert call counts on across tests.
	},
	resolve: { tsconfigPaths: true },
});

export default vitestConfig;
