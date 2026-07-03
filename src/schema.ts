import * as v from "@valibot/valibot";

/**
 * Only the fields we actually use are validated. `v.object` strips unknown keys, so the Clash
 * Royale API adding fields will never break parsing.
 */

const CardSchema = v.object({
	name: v.string(),
	/**
	 * Evolutions report `evolutionLevel: 1`, Heroes `evolutionLevel: 2`; absent for ordinary cards.
	 * `fallback` coerces any other/unknown level to `undefined`, so one new card can't fail the
	 * battle. `optional` must nest _inside_ `fallback`: it makes the key absent-able and widens the
	 * output to `1 | 2 | undefined`, which is what lets `undefined` be a valid fallback value (a
	 * fallback must match the wrapped schema's output type — `undefined` alone isn't assignable to
	 * bare `1 | 2`).
	 */
	// oxlint-disable-next-line unicorn/no-useless-undefined -- the fallback value is intentional
	evolutionLevel: v.fallback(v.optional(v.picklist([1, 2])), undefined),
});

/**
 * Canonical player tag: uppercase with a leading "#". Config and API tags both normalize here, so
 * consumers (player lookup, KV cursor keys) can compare them with plain `===`.
 */
const TagSchema = v.pipe(
	v.string(),
	v.transform((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
	v.toUpperCase()
);

const PlayerSchema = v.object({
	tag: TagSchema,
	name: v.string(),
	crowns: v.number(),
	/**
	 * Trophy progression for the match. Present on trophy-road/ladder games; absent in modes without
	 * trophies (tournaments, friendlies, Path of Legend), so both are optional. Trophies after the
	 * match are derived as `startingTrophies + trophyChange`.
	 */
	startingTrophies: v.optional(v.number()),
	trophyChange: v.optional(v.number()),
	/**
	 * Tower HP remaining at match end. The API omits destroyed towers, so we backfill them as 0 — a
	 * tower is destroyed exactly when its HP hits 0, so a felled tower reads as the lowest possible
	 * rather than vanishing. King defaults to 0; the princess array is always padded to its full
	 * two.
	 */
	kingTowerHitPoints: v.optional(v.number(), 0),
	princessTowersHitPoints: v.pipe(
		v.nullish(v.array(v.number()), []),
		v.transform((hp): [number, number] => [hp[0] ?? 0, hp[1] ?? 0])
	),
	cards: v.array(CardSchema),
	supportCards: v.array(CardSchema),
});

const BattleSchema = v.object({
	type: v.string(),
	/**
	 * Clash Royale sends compact ISO 8601 (e.g. "20240115T143022.000Z"); Temporal parses that basic
	 * format natively and rejects invalid dates. fractionalSecondDigits keeps the exact fixed-width
	 * ".000Z" shape the KV cursors already store, so string order stays chronological.
	 */
	battleTime: v.pipe(
		v.string(),
		v.rawTransform(({ dataset, addIssue, NEVER }) => {
			try {
				return Temporal.Instant.from(dataset.value).toString({ fractionalSecondDigits: 3 });
			} catch {
				addIssue({ message: "Invalid battleTime" });
				return NEVER;
			}
		})
	),
	gameMode: v.optional(v.object({ name: v.string() })),
	team: v.array(PlayerSchema),
	opponent: v.array(PlayerSchema),
});

/** A single player to track and the Discord webhook to notify for them. */
const TargetSchema = v.object({
	tag: TagSchema,
	webhook: v.pipe(v.string(), v.url()),
});

/**
 * The raw TARGETS env var: a JSON string of Target pairs. parseJson makes malformed JSON a normal
 * validation issue, and an unset env var (undefined) fails the string step instead of throwing.
 */
const TargetsEnvSchema = v.pipe(v.string(), v.parseJson(), v.array(TargetSchema));

type Player = v.InferOutput<typeof PlayerSchema>;
type Battle = v.InferOutput<typeof BattleSchema>;
type Target = v.InferOutput<typeof TargetSchema>;
type Card = v.InferOutput<typeof CardSchema>;

export { BattleSchema, TargetsEnvSchema };
export type { Battle, Card, Player, Target };
