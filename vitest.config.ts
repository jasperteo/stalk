import { defineConfig } from "vitest/config";

const vitestConfig = defineConfig({
	test: {
		// Every test file is in src/. Limiting discovery to it keeps Vitest from walking the card art
		// in images/ and the scripts in scripts/.
		dir: "./src",
		// Selects Vitest's environment without DOM globals. The tests still run under Deno, so
		// `Deno.*` is the real API and tests spy on it directly.
		environment: "node",
		// These undo spies, global stubs and env stubs before each test. No test uses `.concurrent`:
		// several tests replace shared globals (`fetch`, `Deno.openKv`, `Deno.cron`), and tests
		// running at the same time in one file would overwrite each other's stubs.
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
		// `clearMocks` stays at Vitest's default, which is on. It clears the call history of every
		// mock, including the `vi.fn()`s created in `vi.mock` factories and manual mocks, which
		// `restoreMocks` leaves alone. The discord, poll and main tests count calls on those.
	},
	// Resolves the `@/` import alias from `tsconfig.json`'s `paths`.
	resolve: { tsconfigPaths: true },
});

export default vitestConfig;
