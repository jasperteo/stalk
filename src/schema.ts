import * as v from "valibot";

/**
 * Only the fields we actually use are validated. `v.object` strips unknown keys, so the Clash
 * Royale API adding fields will never break parsing.
 */

const CardSchema = v.object({
	name: v.string(),
	// Evolutions report `evolutionLevel: 1`, Heroes `evolutionLevel: 2`; absent for ordinary cards.
	// `fallback` coerces any other/unknown level to `undefined`, so one new card can't fail the battle.
	// `optional` must nest *inside* `fallback`: it makes the key absent-able and widens the output to
	// `1 | 2 | undefined`, which is what lets `undefined` be a valid fallback value (a fallback must
	// match the wrapped schema's output type — `undefined` alone isn't assignable to bare `1 | 2`).
	// oxlint-disable-next-line unicorn/no-useless-undefined -- the fallback value is intentional
	evolutionLevel: v.fallback(v.optional(v.picklist([1, 2])), undefined),
});

const PlayerSchema = v.object({
	tag: v.string(),
	name: v.string(),
	crowns: v.number(),
	// Trophy progression for the match. Present on trophy-road/ladder games; absent in modes without
	// trophies (tournaments, friendlies, Path of Legend), so both are optional. Trophies after the
	// match are derived as `startingTrophies + trophyChange`.
	startingTrophies: v.optional(v.number()),
	trophyChange: v.optional(v.number()),
	// Tower HP remaining at match end. The API omits destroyed towers, so we backfill them as 0 — a
	// tower is destroyed exactly when its HP hits 0, so a felled tower reads as the lowest possible
	// rather than vanishing. King defaults to 0; the princess array is always padded to its full two.
	kingTowerHitPoints: v.optional(v.number(), 0),
	princessTowersHitPoints: v.pipe(
		v.nullish(v.array(v.number()), []),
		v.transform((hp): [number, number] => [hp[0] ?? 0, hp[1] ?? 0])
	),
	cards: v.array(CardSchema),
	supportCards: v.array(CardSchema),
});

export const BattleSchema = v.object({
	type: v.string(),
	// Clash Royale sends compact ISO 8601 (e.g. "20240115T143022.000Z"); normalize to standard ISO.
	battleTime: v.pipe(
		v.string(),
		v.transform((value) =>
			value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6")
		),
		v.isoTimestamp()
	),
	gameMode: v.optional(v.object({ name: v.string() })),
	team: v.array(PlayerSchema),
	opponent: v.array(PlayerSchema),
});

/** A single player to track and the Discord webhook to notify for them. */
const TargetSchema = v.object({
	tag: v.string(),
	webhook: v.pipe(v.string(), v.url()),
});

export const TargetsSchema = v.array(TargetSchema);

export type Player = v.InferOutput<typeof PlayerSchema>;
export type Battle = v.InferOutput<typeof BattleSchema>;
export type Target = v.InferOutput<typeof TargetSchema>;
export type Card = v.InferOutput<typeof CardSchema>;
