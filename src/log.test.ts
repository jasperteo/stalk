import { describe, expect, test, vi } from "vitest";

// `log.ts` binds `console.info`/`warn`/`error`/`debug` into its closures once at module import
// time, so a spy installed after a static top-level import is too late to intercept anything.
// Each test spies first, then resets modules and re-imports fresh, so the module's closures
// capture the spies instead of the native console methods.
const spy = (method: "info" | "warn" | "error" | "debug") =>
	vi.spyOn(console, method).mockImplementation(() => undefined);

async function importLog() {
	vi.resetModules();
	const spies = { info: spy("info"), warn: spy("warn"), error: spy("error"), debug: spy("debug") };

	const mod = await import("@/log.ts");

	return { ...mod, spies };
}

describe("log", () => {
	// The badges are padded to a shared fixed width so lines align — the table keeps them
	// column-aligned here too, making a drifted pad width visible at a glance.
	test.each([
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

describe("hl", () => {
	test("entity/value/strong are identity functions when color is disabled", async () => {
		const { hl } = await importLog();

		expect(hl.entity("tag")).toBe("tag");
		expect(hl.value("42")).toBe("42");
		expect(hl.strong("bold")).toBe("bold");
	});
});

describe("levelColor", () => {
	test("exposes an identity paint function per level when color is disabled", async () => {
		const { levelColor } = await importLog();

		expect(levelColor.info("x")).toBe("x");
		expect(levelColor.ok("x")).toBe("x");
		expect(levelColor.warn("x")).toBe("x");
		expect(levelColor.error("x")).toBe("x");
		expect(levelColor.debug("x")).toBe("x");
	});
});
