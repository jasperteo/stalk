import { afterEach, vi } from "vitest";

// The KV captured by the current test's spy. The module under test opens a fresh `:memory:` store
// it never closes (production holds one handle for the isolate's lifetime); the `afterEach` below
// closes it so tests don't accumulate open KV resources for the worker's lifetime.
let openedKv: Deno.Kv | undefined;

afterEach(() => {
	openedKv?.close();
	openedKv = undefined;
});

/**
 * Spies `Deno.openKv`, redirecting the module-under-test's top-level `await Deno.openKv()` to a
 * fresh isolated `:memory:` store. Call before `vi.resetModules()` + import; the returned getter
 * hands back the captured handle (throwing if the spy never ran) for direct KV manipulation.
 */
function spyMemoryKv() {
	// `restoreMocks` puts the real `Deno.openKv` back before each test, so capturing it here (rather
	// than calling `Deno.openKv` from inside the mock, which would recurse into the spy itself) always
	// grabs the genuine implementation.
	const openKv = Deno.openKv.bind(Deno);

	vi.spyOn(Deno, "openKv").mockImplementation(async () => {
		openedKv = await openKv(":memory:");
		return openedKv;
	});

	return () => {
		if (openedKv === undefined) throw new Error("Deno.openKv handle was never captured");
		return openedKv;
	};
}

export { spyMemoryKv };
