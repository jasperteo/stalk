/**
 * @module
 *
 * Manual vitest mock for `@/log.ts`, picked up automatically by any bare `vi.mock("@/log.ts")` (no
 * factory). One canonical copy of the module's export list, so a new export means one edit here
 * instead of one per test file. `hl`/`levelColor` are identity functions, matching the real
 * module's behavior when color is disabled (which log.test.ts asserts against the real module).
 */

import { vi } from "vitest";

/** The five leveled methods, each a spy so tests can assert on calls. */
const log = {
	info: vi.fn(),
	success: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

const hl = {
	entity: (s: string) => s,
	value: (s: string) => s,
	strong: (s: string) => s,
};

const levelColor = {
	info: (s: string) => s,
	ok: (s: string) => s,
	warn: (s: string) => s,
	error: (s: string) => s,
	debug: (s: string) => s,
};

/**
 * Mirrors the real helper rather than spying on it: no test asserts on the call, but the
 * error-message assertions read what it returns. The cap matches `log.ts`'s `ERROR_BODY_CHARS`,
 * which that module keeps private.
 */
const truncatedBody = async (response: Response) => {
	const body = await response.text();
	return body.slice(0, 2000);
};

export { hl, levelColor, log, truncatedBody };
