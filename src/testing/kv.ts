import { onTestFinished, vi } from "vitest";

/**
 * Spies `Deno.openKv`, redirecting the module-under-test's top-level `await Deno.openKv()` to a
 * fresh isolated `:memory:` store. Call from inside a test, before `vi.resetModules()` + import;
 * the returned getter hands back the captured handle (throwing if the spy never ran) for direct KV
 * manipulation.
 *
 * The module under test never closes the store it opens (production holds one handle for the
 * isolate's lifetime), so this closes it via `onTestFinished` — scoped to the calling test rather
 * than a module-level `afterEach` over shared state, so the handle can't outlive or leak between
 * tests.
 */
function spyMemoryKv() {
	// `restoreMocks` puts the real `Deno.openKv` back before each test, so capturing it here (rather
	// than calling `Deno.openKv` from inside the mock, which would recurse into the spy itself) always
	// grabs the genuine implementation.
	const openKv = Deno.openKv.bind(Deno);

	let openedKv: Deno.Kv | undefined;

	onTestFinished(() => {
		openedKv?.close();
	});

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
