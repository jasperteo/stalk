/**
 * @module
 *
 * Reads `CR_API_TOKEN` and `TARGETS` once, while the module is evaluated, and exposes the result as
 * {@link config}. Locally the values come from `.env` (`pnpm start` passes `--env-file`); on Deno
 * Deploy they come from the project's environment variables.
 *
 * Deno Deploy stops an idle instance after roughly 20 to 30 seconds. With one cron tick a minute,
 * most ticks start a fresh instance, so this module, and every log line it prints, runs about once
 * per tick.
 */

import * as v from "valibot";

import { hl, log } from "@/log.ts";
import { TargetsEnvSchema, TokenEnvSchema } from "@/schema.ts";

/**
 * Reads one env var and validates it against `schema`. Both failure cases log once and return
 * `fallback` rather than throw. A throw here would fail module evaluation, and with it the HTTP
 * server and the cron registration in `main.ts`.
 *
 * An unset var logs at info level and an invalid one at error level. Unset means the deploy is not
 * configured yet, which is a normal state, and because this module runs again on most ticks, an
 * error level would print an error every minute for it. `main.ts` is the one place that stays loud
 * about a missing token: its cron handler warns on every tick.
 *
 * @template TOutput The schema's output type. `fallback` has the same type, so both return paths
 *   agree and callers use the result without narrowing it.
 * @param name The env var to read.
 * @param schema Validates the raw string and may transform it.
 * @param fallback Returned, after the log line, when the var is unset or invalid.
 */
function parseEnv<TOutput>(
	name: string,
	schema: v.GenericSchema<string, TOutput>,
	fallback: TOutput
) {
	const raw = Deno.env.get(name);

	if (raw === undefined) {
		log.info(`${hl.entity(name)} is not set`);
		return fallback;
	}

	const parsed = v.safeParse(schema, raw);

	if (!parsed.success) {
		log.error(`Invalid ${hl.entity(name)} env var:`, v.flatten(parsed.issues));
		return fallback;
	}

	return parsed.output;
}

/** The token env var's name. Exported so that tests stub the exact name this module reads. */
const TOKEN_VAR = "CR_API_TOKEN";
/** The targets env var's name. Exported so that tests stub the exact name this module reads. */
const TARGETS_VAR = "TARGETS";

// An unset or invalid token becomes `undefined`, which `config` below treats as "not configured".
const token = parseEnv(TOKEN_VAR, TokenEnvSchema, undefined);
// An unset or invalid TARGETS becomes an empty list: every tick polls nobody, while the heartbeat
// and the HTTP routes keep running.
const targets = parseEnv(TARGETS_VAR, TargetsEnvSchema, []);

/**
 * The poll configuration, or `undefined` when `CR_API_TOKEN` is unset or invalid. Pairing the token
 * with the targets in one optional value gives consumers a single check: once `config` is known to
 * be defined, the token is too.
 */
const config = token === undefined ? undefined : { token, targets };

export { config, TARGETS_VAR, TOKEN_VAR };
