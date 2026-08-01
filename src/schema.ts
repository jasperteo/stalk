import * as v from "@valibot/valibot";

/**
 * Only the fields we actually use are validated. `v.object` strips unknown keys, so the Clash
 * Royale API adding fields will never break parsing.
 */

const UrlSchema = v.pipe(v.string(), v.url());

const CardSchema = v.object({
	/**
	 * Numeric card id (e.g. 28000011), always present on battle-log cards including `supportCards`.
	 * The deck renderer's local-art lookup key (`<id>.png` in `images/`).
	 */
	id: v.number(),
	name: v.string(),
	/**
	 * Evolutions report `evolutionLevel: 1`, Heroes report `2`; ordinary cards omit it. `fallback`
	 * coerces any other/unknown value to `undefined` so one new card can't fail the battle.
	 * `optional` must nest _inside_ `fallback`, not outside: a fallback's replacement value must
	 * match the wrapped schema's output type, and only `optional`'s output includes `undefined`.
	 */
	evolutionLevel: v.fallback(v.optional(v.picklist([1, 2])), undefined),
	/**
	 * CDN card art. `medium` is always present; `evolutionMedium`/`heroMedium` exist only on
	 * Evolution/Hero cards (matching `evolutionLevel` 1/2), so the deck renderer picks the variant
	 * and falls back to `medium`.
	 */
	iconUrls: v.object({
		medium: UrlSchema,
		evolutionMedium: v.optional(UrlSchema),
		heroMedium: v.optional(UrlSchema),
	}),
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
	 * Trophy progression for the match. Present on trophy-road/ladder games, absent in modes without
	 * trophies (tournaments, friendlies, Path of Legend). Trophies after the match are derived as
	 * `startingTrophies + trophyChange`.
	 */
	startingTrophies: v.optional(v.number()),
	trophyChange: v.optional(v.number()),
	/**
	 * Tower HP remaining at match end. The API omits destroyed towers, so we backfill them as 0 — a
	 * tower is destroyed exactly when its HP hits 0. King defaults to 0; the princess array is always
	 * padded to its full two.
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
	 * Clash Royale sends compact ISO 8601 (e.g. "20240115T143022.000Z"); Temporal parses that and
	 * rejects invalid dates. Fixing `fractionalSecondDigits` keeps the fixed-width shape KV cursors
	 * store, so plain string comparison stays chronological.
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

/**
 * Cheap eligibility check: reuses BattleSchema's own battleTime rule and requires a single `team`
 * entry (1v1), without the cost of full battle validation. Malformed or 2v2 entries fall back to
 * "", the sentinel `latestBattle` reads as "not eligible, keep looking".
 */
const EligibleBattleTimeSchema = v.fallback(
	v.pipe(
		v.object({
			battleTime: BattleSchema.entries.battleTime,
			team: v.pipe(v.array(v.unknown()), v.length(1)),
		}),
		v.transform((battle) => battle.battleTime)
	),
	""
);

/**
 * A stored lastBattle KV cursor. Reuses BattleSchema's own battleTime rule, so parsing it also
 * re-normalizes and validates the stored value instead of trusting a raw `kv.get<string>` cast.
 */
const CursorSchema = BattleSchema.entries.battleTime;

/** CR_API_TOKEN: rejects both an unset env var and an empty string. */
const TokenEnvSchema = v.pipe(v.string(), v.nonEmpty());

/** A single player to track and the Discord webhook to notify for them. */
const TargetSchema = v.object({
	tag: TagSchema,
	webhook: UrlSchema,
});

/**
 * The raw TARGETS env var: a JSON string of Target pairs. `parseJson` turns malformed JSON into a
 * normal validation issue rather than a thrown error; an unset env var fails the string step.
 */
const TargetsEnvSchema = v.pipe(v.string(), v.parseJson(), v.array(TargetSchema));

type Player = v.InferOutput<typeof PlayerSchema>;
type Battle = v.InferOutput<typeof BattleSchema>;
type Target = v.InferOutput<typeof TargetSchema>;
type Card = v.InferOutput<typeof CardSchema>;

export { BattleSchema, CursorSchema, EligibleBattleTimeSchema, TargetsEnvSchema, TokenEnvSchema };
export type { Battle, Card, Player, Target };
