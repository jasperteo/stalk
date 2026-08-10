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

// `@std/fmt/colors` only gates on NO_COLOR, not on whether stdout is a terminal, so gate on both
// here: piped/captured output (CI, Deno Deploy logs) stays plain text.
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
 * Inline highlighters for dynamic values in log messages: `entity` for the identifier a line is
 * about, `value` for a standout measurement or address, `strong` for bare emphasis. Defined here so
 * no other file imports `@std/fmt/colors` and paints before the gate above has run.
 */
const hl = { entity: brightMagenta, value: brightBlue, strong: bold };

/** Bold, colored, fixed-width level tag ("info" → "info ", "ok" → "ok ") so lines align. */
const badge = (text: string, paint: (str: string) => string) => paint(bold(text.padEnd(5)));

// Built once at module load, after the setColorEnabled call, so they bake in the right color
// decision.
const INFO = badge("info", levelColor.info);
const OK = badge("ok", levelColor.ok);
const WARN = badge("warn", levelColor.warn);
const ERROR = badge("error", levelColor.error);
const DEBUG = badge("debug", levelColor.debug);

/** Builds one leveled logger from its console method, badge, and optional message tint. */
const leveled =
	(write: (...data: unknown[]) => void, label: string, tint = (message: string) => message) =>
	(message: string, ...rest: unknown[]) => {
		write(label, tint(message), ...rest);
	};

/**
 * Console wrapper: every line gets a colored level badge so local dev and Deno Deploy logs read as
 * one consistent stream. warn/error also tint the message text; debug greys its message since it's
 * verbose diagnostic detail rather than something to act on. Extra args are left unpainted, so e.g.
 * `log.error("…", err)` keeps the Error object's native console inspection (stack trace, etc.).
 */
const log = {
	info: leveled(console.info, INFO),
	success: leveled(console.info, OK),
	warn: leveled(console.warn, WARN, levelColor.warn),
	error: leveled(console.error, ERROR, levelColor.error),
	debug: leveled(console.debug, DEBUG, levelColor.debug),
};

export { hl, levelColor, log };
