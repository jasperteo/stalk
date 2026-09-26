/**
 * @module
 *
 * Leveled console output for the whole app. Every line starts with a colored, fixed-width level
 * badge, so a local run and the Deno Deploy log stream read the same way.
 *
 * This is the only module that imports `@std/fmt/colors`. The color functions check a module-level
 * flag each time they run, and this module sets that flag before it paints anything. Every other
 * module gets its colors from {@link levelColor} and {@link hl}, which means importing this module
 * first, so no paint call anywhere can run before the flag is set.
 */

import {
	bold,
	brightBlue,
	brightMagenta,
	cyan,
	gray,
	green,
	red,
	setColorEnabled,
	yellow,
} from "@std/fmt/colors";

// `@std/fmt/colors` only checks NO_COLOR by itself. Output that is piped rather than shown in a
// terminal (the Deno Deploy log stream, CI, a test run) would still carry ANSI escape codes, so
// require a terminal as well.
setColorEnabled(!Deno.noColor && Deno.stdout.isTerminal());

/**
 * The color of each level's badge. `main.ts` colors its per-tick tally with the same functions, so
 * an outcome appears in the color of the log level that reports it.
 */
const levelColor = {
	info: cyan,
	ok: green,
	warn: yellow,
	error: red,
	debug: gray,
} as const;

/**
 * Highlighters for values inside a message. `entity` marks what the line is about (a player tag, an
 * env var name), `value` marks a measurement or an address, and `strong` marks a number that must
 * stand out. They live here so that callers never import `@std/fmt/colors` themselves.
 */
const hl = { entity: brightMagenta, value: brightBlue, strong: bold };

/**
 * How many characters of a failed response's body {@link truncatedBody} keeps. Discord describes a
 * malformed embed inside a nested JSON error, and the Clash Royale API puts its reason in the body,
 * so the log line needs room for the part that explains the failure. The cap exists because an
 * upstream HTML error page can run to several kilobytes and would be logged again on every tick of
 * an outage.
 */
const ERROR_BODY_CHARS = 2000;

/**
 * Reads a failed response's body for a log line or an error message. Callers write their own prefix
 * (status, URL, player tag) around it.
 *
 * Reading the body consumes it and releases the connection, so call this at most once per response,
 * and only on the failure path.
 *
 * @returns The body text, cut to {@link ERROR_BODY_CHARS} characters.
 */
async function truncatedBody(response: Response) {
	const body = await response.text();
	return body.slice(0, ERROR_BODY_CHARS);
}

/**
 * Builds one leveled logger. Its badge is the level name, padded to five characters so that
 * messages line up across levels, printed bold in the level's color.
 *
 * @param write The console method to call. It is a separate argument from `level` because `success`
 *   writes through `console.info` under its own `ok` badge.
 * @param level Selects the badge text and its color.
 * @param tint Whether to paint the message in the level's color as well. Extra arguments are never
 *   painted, so an `Error` passed after the message keeps the console's own formatting, stack trace
 *   included.
 * @returns A logger whose badge was painted once, when this function ran. `leveled` only runs while
 *   this module builds {@link log}, after the `setColorEnabled` call above.
 */
function leveled(
	write: (...data: unknown[]) => void,
	level: keyof typeof levelColor,
	tint = false
) {
	const paint = levelColor[level];
	const badge = paint(bold(level.padEnd(5)));

	return (message: string, ...rest: unknown[]) => {
		write(badge, tint ? paint(message) : message, ...rest);
	};
}

/**
 * The app's logger. `warn` and `error` tint the message text so it stands out, and `debug` tints it
 * gray so that diagnostic detail reads as secondary. `info` and `success` leave the message plain.
 */
const log = {
	info: leveled(console.info, "info"),
	success: leveled(console.info, "ok"),
	warn: leveled(console.warn, "warn", true),
	error: leveled(console.error, "error", true),
	debug: leveled(console.debug, "debug", true),
};

export { hl, levelColor, log, truncatedBody };
