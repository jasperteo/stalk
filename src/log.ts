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
 * Builds one leveled logger: a bold, colored, 5-wide badge (so lines align) in front of every
 * message, optionally tinting the message itself in the same color.
 */
const leveled = (
	write: (...data: unknown[]) => void,
	level: keyof typeof levelColor,
	tint = false
) => {
	const paint = levelColor[level];
	// Baked once here — while the `log` literal below evaluates, so after the setColorEnabled gate.
	const badge = paint(bold(level.padEnd(5)));

	return (message: string, ...rest: unknown[]) => {
		write(badge, tint ? paint(message) : message, ...rest);
	};
};

/**
 * Console wrapper: every line carries a colored level badge so local dev and Deno Deploy logs read
 * as one stream. warn/error/debug also tint their message — debug because it's verbose diagnostic
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

export { hl, levelColor, log };
