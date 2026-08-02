import * as v from "valibot";

import { hl, log } from "@/log.ts";
import { TargetsEnvSchema, TokenEnvSchema } from "@/schema.ts";

/** Reads and validates a single env var, logging once and falling back on a missing/invalid value. */
function parseEnv<TOutput>(
	name: string,
	schema: v.GenericSchema<string | undefined, TOutput>,
	fallback: TOutput
) {
	const parsed = v.safeParse(schema, Deno.env.get(name));

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
