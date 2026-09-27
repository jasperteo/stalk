/**
 * @module
 *
 * The manual mock for `@/log.ts`. Vitest uses it for every `vi.mock(import("@/log.ts"))` call that
 * passes no factory, so the mocked export list lives in this one file, and a new export from
 * `log.ts` needs one change here instead of one per test file.
 *
 * `hl` and `levelColor` are identity functions, which is how the real ones behave with color turned
 * off (`log.test.ts` checks that). Tests can therefore compare whole log lines, colors and all, as
 * plain strings.
 */

import { vi } from "vitest";

import type * as LogModule from "@/log.ts";

/** The five logging methods, each a spy so tests can assert on the calls. */
const log = {
	info: vi.fn(),
	success: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

/** Identity highlighters, matching the real `hl` with color off. */
const hl = {
	entity: (s: string) => s,
	value: (s: string) => s,
	strong: (s: string) => s,
};

/** Identity badge colors, matching the real `levelColor` with color off. */
const levelColor = {
	info: (s: string) => s,
	ok: (s: string) => s,
	warn: (s: string) => s,
	error: (s: string) => s,
	debug: (s: string) => s,
};

/**
 * The real `truncatedBody`. No test asserts on calls to it, but error-message assertions read what
 * it returns, and its length cap is private to `log.ts`. A copy here would repeat that cap where
 * nothing would notice it going out of date.
 */
const { truncatedBody } = await vi.importActual<typeof LogModule>("@/log.ts");

export { hl, levelColor, log, truncatedBody };
