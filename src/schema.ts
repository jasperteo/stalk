import * as v from "valibot";

/**
 * Only the fields we actually use are validated. `v.object` strips unknown keys, so the Clash
 * Royale API adding fields will never break parsing.
 */

const CardSchema = v.object({
	name: v.string(),
	// Evolutions report `evolutionLevel: 1`, Heroes `evolutionLevel: 2`; absent for ordinary cards.
	// `fallback` coerces any other/unknown level to `undefined`, so one new card can't fail the battle.
	// oxlint-disable-next-line unicorn/no-useless-undefined -- the fallback value is intentional
	evolutionLevel: v.fallback(v.optional(v.picklist([1, 2])), undefined),
});

const PlayerSchema = v.object({
	tag: v.string(),
	name: v.string(),
	crowns: v.number(),
	// Tower HP remaining at match end. The API omits destroyed towers, so both are optional and the
	// princess array can be length 0–2.
	kingTowerHitPoints: v.optional(v.number()),
	princessTowersHitPoints: v.optional(v.array(v.number())),
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
