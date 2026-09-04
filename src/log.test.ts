import { describe, expect, test, vi } from "vitest";

// `log.ts` binds `console.info`/`warn`/`error`/`debug` into its closures once at module import
// time, so a spy installed after a static top-level import is too late to intercept anything.
// Each test spies first, then resets modules and re-imports fresh, so the module's closures
// capture the spies instead of the native console methods.
function spy(method: "info" | "warn" | "error" | "debug") {
	return vi.spyOn(console, method).mockImplementation(() => undefined);
}

async function importLog() {
	vi.resetModules();
	const spies = { info: spy("info"), warn: spy("warn"), error: spy("error"), debug: spy("debug") };

	const mod = await import("@/log.ts");

	return { ...mod, spies };
}

describe("log", () => {
	// The badges are padded to a shared fixed width so lines align. The table keeps them
	// column-aligned here too, making a drifted pad width visible at a glance.
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

// One fact about two export groups: with color disabled, every paint function is identity. Merged
// into a single test because splitting it paid two `vi.resetModules()` + re-import cycles to assert
// the same thing twice. This is what justifies the identity stubs in `src/__mocks__/log.ts`, which
// main.test.ts's exact tally-line assertion depends on.
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
