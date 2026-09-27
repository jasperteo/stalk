/**
 * @module
 *
 * A `Deno.openKv` spy for tests of modules that open KV at the top level. Vitest runs inside Deno,
 * so `Deno.openKv` is the real function, and the spy swaps what it opens rather than mocking a
 * wrapper module.
 */

import { onTestFinished, vi } from "vitest";

/**
 * Makes the next `Deno.openKv()` call open a fresh in-memory store, then closes that store when the
 * calling test finishes.
 *
 * Call it inside a test body, before `vi.resetModules()` and the dynamic import of the module under
 * test, so that module's top-level `await Deno.openKv()` runs against the spy. `onTestFinished`
 * ties the close to the test that opened the store. The module under test never closes its handle,
 * and a hook shared across tests could close the wrong one or let a handle outlive its test.
 *
 * @returns A getter for the opened handle, for tests that read, write or spy on KV directly. It
 *   throws if the module under test never called `Deno.openKv`.
 */
function spyMemoryKv() {
	// `restoreMocks` puts the real `Deno.openKv` back before each test, so this captures the real
	// function. Calling `Deno.openKv` inside the mock instead would call the spy itself, forever.
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
