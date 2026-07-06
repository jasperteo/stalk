import {
	bold,
	brightBlue,
	brightMagenta,
	cyan,
	dim,
	gray,
	green,
	red,
	setColorEnabled,
	yellow,
} from "@std/fmt/colors";

// `@std/fmt/colors` gates only on NO_COLOR (`Deno.noColor`), never on whether stdout is a terminal
// — so piped or platform-captured output (CI, `| tee`, Deno Deploy's log capture) would keep raw
// ANSI escapes. Gate on both here: a human terminal gets color, everything else gets plain text.
setColorEnabled(!Deno.noColor && Deno.stdout.isTerminal());

/**
 * Level → color, the single source of the badge palette. Exported so callers that color per-level
 * data (e.g. the cron tally in main.ts) match the badges by construction instead of by convention.
 */
export const levelColor = {
	info: cyan,
	ok: green,
	warn: yellow,
	error: red,
	debug: gray,
} as const;

/**
 * Inline highlighters for dynamic values inside log messages: `entity` for the identifier a line is
 * about (player tag, env var name), `value` for a standout measurement or address, `strong` for
 * bare emphasis. Exported from here — the module that owns the setColorEnabled gate above — so no
 * other file imports `@std/fmt/colors` and paints before the gate has run. The colors deliberately
 * avoid the level meanings in `levelColor`. Nesting inside a tinted warn/error message is safe (the
 * outer color re-opens after the inner reset), but don't use `strong` inside a debug message: bold
 * and dim share close code 22, so the dim wouldn't survive past the highlight.
 */
export const hl = { entity: brightMagenta, value: brightBlue, strong: bold };

/** Bold, colored, fixed-width level tag ("info" → "info ", "ok" → "ok ") so lines align. */
const badge = (text: string, paint: (str: string) => string) => paint(bold(text.padEnd(5)));

// Badges are pure constants — build each once at module load (after the setColorEnabled call
// above, so they bake in the right color decision) instead of re-painting on every log call.
const INFO = badge("info", levelColor.info);
const OK = badge("ok", levelColor.ok);
const WARN = badge("warn", levelColor.warn);
const ERROR = badge("error", levelColor.error);
const DEBUG = badge("debug", levelColor.debug);

/**
 * Console wrapper: every line gets a colored level badge so local dev and Deno Deploy logs read as
 * one consistent stream instead of an undifferentiated wall. warn/error also tint the message text
 * so a problem line is scannable as a whole, and debug dims its message since it's verbose
 * diagnostic detail rather than something to act on. Extra args are left unpainted —
 * `log.error("…", err)` keeps the Error object's native console inspection (stack trace, etc.),
 * which stringifying it through a color function would flatten.
 */
export const log = {
	info: (message: string, ...rest: unknown[]) => {
		console.info(INFO, message, ...rest);
	},
	success: (message: string, ...rest: unknown[]) => {
		console.info(OK, message, ...rest);
	},
	warn: (message: string, ...rest: unknown[]) => {
		console.warn(WARN, levelColor.warn(message), ...rest);
	},
	error: (message: string, ...rest: unknown[]) => {
		console.error(ERROR, levelColor.error(message), ...rest);
	},
	debug: (message: string, ...rest: unknown[]) => {
		console.debug(DEBUG, dim(message), ...rest);
	},
};
