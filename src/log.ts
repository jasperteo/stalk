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

// `@std/fmt/colors` gates on NO_COLOR only, not on whether stdout is a terminal, so gate on both:
// piped/captured output (CI, Deno Deploy logs) stays plain text. Runs before anything paints.
setColorEnabled(!Deno.noColor && Deno.stdout.isTerminal());

/** Level → color, the single source of the badge palette. */
const levelColor = {
	info: cyan,
	ok: green,
	warn: yellow,
	error: red,
	debug: gray,
} as const;

/**
 * Inline highlighters for dynamic values: `entity` for the identifier a line is about, `value` for
 * a measurement or address, `strong` for bare emphasis. Defined here so no other file imports
 * `@std/fmt/colors` and paints before the gate above has run.
 */
const hl = { entity: brightMagenta, value: brightBlue, strong: bold };

/**
 * How much of an error body to echo into a log line. Generous, because a Discord malformed-embed
 * detail, or a Clash Royale API error message, can be buried deep inside a nested JSON body, and
 * that log line is the only record of it. Still capped, since an edge proxy's 5xx returns a
 * multi-KB HTML page that would otherwise flood the Deploy logs every tick of an outage.
 */
const ERROR_BODY_CHARS = 2000;

/**
 * Builds one leveled logger: a bold, colored, 5-wide badge (so lines align) in front of every
 * message, optionally tinting the message itself in the same color.
 *
 * @param write The console method to wrap, passed in rather than derived from `level` so `success`
 *   can route to `console.info` under its own badge.
 * @param tint Whether to paint the message itself, not just the badge. Extra args stay unpainted
 *   regardless, so an Error keeps its native console inspection.
 * @returns The logger, with its badge already painted. Computing it once here is what keeps every
 *   paint call after the `setColorEnabled` gate above.
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
 * Console wrapper: every line carries a colored level badge so local dev and Deno Deploy logs read
 * as one stream. warn/error/debug also tint their message, debug because it's verbose diagnostic
 * detail rather than something to act on. Extra args are left unpainted, so an Error handed to
 * `log.error` keeps its native console inspection (stack trace, etc.).
 */
const log = {
	info: leveled(console.info, "info"),
	success: leveled(console.info, "ok"),
	warn: leveled(console.warn, "warn", true),
	error: leveled(console.error, "error", true),
	debug: leveled(console.debug, "debug", true),
};

export { ERROR_BODY_CHARS, hl, levelColor, log };
