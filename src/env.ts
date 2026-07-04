import * as v from "@valibot/valibot";

import { TargetsEnvSchema, TokenEnvSchema } from "@/schema.ts";

/** Reads and validates a single env var, logging once and falling back on a missing/invalid value. */
function parseEnv<TOutput>(
	name: string,
	schema: v.GenericSchema<string | undefined, TOutput>,
	fallback: TOutput
) {
	const parsed = v.safeParse(schema, Deno.env.get(name));

	if (!parsed.success) {
		console.error(`Invalid ${name} env var:`, v.flatten(parsed.issues));
		return fallback;
	}

	return parsed.output;
}

const token = parseEnv("CR_API_TOKEN", TokenEnvSchema, undefined);
const targets = parseEnv("TARGETS", TargetsEnvSchema, []);

/**
 * Poll configuration, or undefined when CR_API_TOKEN is missing — consumers guard once instead of
 * re-checking the token. Destructured locals stay narrowed inside closures, unlike imported
 * bindings, which TypeScript re-widens when a nested function captures them.
 */
const config = token === undefined ? undefined : { token, targets };

export { config };
