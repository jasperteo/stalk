import * as v from "valibot";

/**
 * Only the fields we actually use are validated. `v.object` strips unknown keys, so the Clash
 * Royale API adding fields will never break parsing.
 */

const CardSchema = v.object({
	name: v.string(),
});

const PlayerSchema = v.object({
	tag: v.string(),
	name: v.string(),
	crowns: v.number(),
	cards: v.array(CardSchema),
	supportCards: v.optional(v.array(CardSchema)),
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

export type Player = v.InferOutput<typeof PlayerSchema>;
export type Battle = v.InferOutput<typeof BattleSchema>;
