import { bold, cyan, dim, gray, green, red, setColorEnabled, yellow } from "@std/fmt/colors";

// `@std/fmt/colors` gates only on NO_COLOR (`Deno.noColor`), never on whether stdout is a terminal
// — so piped or platform-captured output (CI, `| tee`, Deno Deploy's log capture) would keep raw
// ANSI escapes. Gate on both here: a human terminal gets color, everything else gets plain text.
setColorEnabled(!Deno.noColor && Deno.stdout.isTerminal());

/** Bold, colored, fixed-width level tag ("info" → "info ", "ok" → "ok ") so lines align. */
const badge = (text: string, paint: (str: string) => string) => paint(bold(text.padEnd(5)));

// Badges are pure constants — build each once at module load (after the setColorEnabled call
// above, so they bake in the right color decision) instead of re-painting on every log call.
const INFO = badge("info", cyan);
const OK = badge("ok", green);
const WARN = badge("warn", yellow);
const ERROR = badge("error", red);
const DEBUG = badge("debug", gray);

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
		console.warn(WARN, yellow(message), ...rest);
	},
	error: (message: string, ...rest: unknown[]) => {
		console.error(ERROR, red(message), ...rest);
	},
	debug: (message: string, ...rest: unknown[]) => {
		console.debug(DEBUG, dim(message), ...rest);
	},
};
