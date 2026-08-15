import * as v from "valibot";

import { hl, log } from "@/log.ts";
import { TargetsEnvSchema, TokenEnvSchema } from "@/schema.ts";

/**
 * Reads and validates a single env var, logging once and falling back on a missing/invalid value.
 *
 * Unset and malformed are reported differently on purpose. An unset var is a deploy that isn't
 * configured yet, not a mistake in a value someone wrote, and Deno Deploy evaluates this module in
 * a fresh isolate every tick — so logging it at `error` would print an error line a minute for a
 * state that is merely incomplete. Consumers supply the loudness where it's warranted: `main.ts`
 * warns every tick on a missing token.
 *
 * @template TOutput The schema's output type. Tying `fallback` to it is what lets callers
 *   destructure the result without re-narrowing — both paths hand back the same type.
 * @param fallback Returned, after logging, when the var is unset or fails validation.
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

/** Env var names, exported so tests stub the same names this module reads. */
const TOKEN_VAR = "CR_API_TOKEN";
const TARGETS_VAR = "TARGETS";

const token = parseEnv(TOKEN_VAR, TokenEnvSchema, undefined);
const targets = parseEnv(TARGETS_VAR, TargetsEnvSchema, []);

/**
 * Poll configuration, or undefined when CR_API_TOKEN is missing — consumers guard once instead of
 * re-checking the token. Destructured locals stay narrowed inside closures, unlike an imported
 * binding, which TypeScript re-widens once a nested function captures it.
 */
const config = token === undefined ? undefined : { token, targets };

export { config, TARGETS_VAR, TOKEN_VAR };
