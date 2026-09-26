/**
 * @module
 *
 * Tests for `log.ts` against the real module, with the console spied.
 *
 * `log.ts` captures `console.info`, `warn`, `error` and `debug` in its loggers while it is evaluated.
 * A spy installed after a static import would never be called, so each test installs the spies
 * first, then resets the module registry and imports `log.ts` again.
 */

import { describe, expect, test, vi } from "vitest";

/** Silences one console method and returns its spy. */
function spy(method: "info" | "warn" | "error" | "debug") {
	return vi.spyOn(console, method).mockImplementation(() => undefined);
}

/** Spies the console, then evaluates a fresh copy of `log.ts` that captures those spies. */
async function importLog() {
	vi.resetModules();
	const spies = { info: spy("info"), warn: spy("warn"), error: spy("error"), debug: spy("debug") };

	const mod = await import("@/log.ts");

	return { ...mod, spies };
}

describe("log", () => {
	// The expected badges are padded to five characters. Lined up in the table, a wrong pad width is
	// easy to see.
	test.for([
		{ level: "info", badge: "info ", via: "info" },
		{ level: "success", badge: "ok   ", via: "info" },
		{ level: "warn", badge: "warn ", via: "warn" },
		{ level: "error", badge: "error", via: "error" },
		{ level: "debug", badge: "debug", via: "debug" },
	] as const)(
		"$level prefixes the message with its badge via console.$via",
		async ({ level, badge, via }) => {
			const { log, spies } = await importLog();

			log[level]("hello");

			expect(spies[via]).toHaveBeenCalledWith(badge, "hello");
		}
	);

	test("passes extra arguments through after the message untouched", async () => {
		const { log, spies } = await importLog();
		const err = new Error("boom");

		log.error("hello", err);

		expect(spies.error).toHaveBeenCalledWith("error", "hello", err);
	});
});

// Color is off under Vitest, even when the suite runs in a terminal. This test is what makes the
// identity functions in `src/__mocks__/log.ts` a faithful mock, and `main.test.ts` depends on that
// when it compares a whole tally line as a plain string.
describe("hl and levelColor", () => {
	test("every paint function is identity when color is disabled", async () => {
		const { hl, levelColor } = await importLog();

		expect(hl.entity("tag")).toBe("tag");
		expect(hl.value("42")).toBe("42");
		expect(hl.strong("bold")).toBe("bold");

		expect(levelColor.info("x")).toBe("x");
		expect(levelColor.ok("x")).toBe("x");
		expect(levelColor.warn("x")).toBe("x");
		expect(levelColor.error("x")).toBe("x");
		expect(levelColor.debug("x")).toBe("x");
	});
});
