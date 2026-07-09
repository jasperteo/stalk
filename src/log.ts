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

// `@std/fmt/colors` gates only on NO_COLOR (`Deno.noColor`), never on whether stdout is a terminal
// — so piped or platform-captured output (CI, `| tee`, Deno Deploy's log capture) would keep raw
// ANSI escapes. Gate on both here: a human terminal gets color, everything else gets plain text.
setColorEnabled(!Deno.noColor && Deno.stdout.isTerminal());

/**
 * Level → color, the single source of the badge palette. Exported so callers that color per-level
 * data (e.g. the cron tally in main.ts) match the badges by construction instead of by convention.
 */
const levelColor = {
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
 * outer color re-opens after each inner reset), including inside a greyed debug message.
 */
const hl = { entity: brightMagenta, value: brightBlue, strong: bold };

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
 * so a problem line is scannable as a whole, and debug greys its message since it's verbose
 * diagnostic detail rather than something to act on. Extra args are left unpainted —
 * `log.error("…", err)` keeps the Error object's native console inspection (stack trace, etc.),
 * which stringifying it through a color function would flatten.
 */
/**
 * Builds one leveled logger from its console method, badge, and optional message tint — every
 * handler shares this single shape, so badge/tint/method stay in agreement per level by
 * construction (the old hand-written handlers let debug's paint drift to a bespoke `dim`).
 */
const leveled =
	(write: (...data: unknown[]) => void, badge: string, tint = (message: string) => message) =>
	(message: string, ...rest: unknown[]) => {
		write(badge, tint(message), ...rest);
	};

const log = {
	info: leveled(console.info, INFO),
	success: leveled(console.info, OK),
	warn: leveled(console.warn, WARN, levelColor.warn),
	error: leveled(console.error, ERROR, levelColor.error),
	debug: leveled(console.debug, DEBUG, levelColor.debug),
};

export { hl, levelColor, log };
