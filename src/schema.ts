import * as v from "valibot";

/**
 * Valibot schemas for the Clash Royale API shapes and the two env vars. Only the fields we actually
 * use are declared, and `v.object` strips unknown keys, so the API adding fields never breaks
 * parsing.
 */

// ══════════════════════════════════════════ PRIMITIVES ═══════════════════════════════════════════

const UrlSchema = v.pipe(v.string(), v.url());

/**
 * Canonical player tag: uppercase with a leading "#". Config and API tags both normalize here, so
 * consumers (player lookup, KV lastBattle keys) can compare them with plain `===`.
 */
const TagSchema = v.pipe(
	v.string(),
	v.transform((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
	v.toUpperCase()
);

/**
 * Clash Royale sends compact ISO 8601 (e.g. "20240115T143022.000Z"); Temporal parses that and
 * rejects invalid dates. Fixing `fractionalSecondDigits` keeps the fixed-width shape KV lastBattle
 * values store, so plain string comparison stays chronological.
 */
const BattleTimeSchema = v.pipe(
	v.string(),
	v.rawTransform(({ dataset, addIssue, NEVER }) => {
		try {
			return Temporal.Instant.from(dataset.value).toString({ fractionalSecondDigits: 3 });
		} catch {
			addIssue({ message: "Invalid battleTime" });
			return NEVER;
		}
	})
);

// ══════════════════════════════════════════ API SHAPES ═══════════════════════════════════════════

const CardSchema = v.object({
	/**
	 * Numeric card id (e.g. 28000011), always present on battle-log cards including `supportCards`.
	 * The deck renderer's local-art lookup key (`<id>.png` in `images/`).
	 */
	id: v.number(),
	name: v.string(),
	/**
	 * Evolutions report `evolutionLevel: 1`, Heroes report `2`; ordinary cards omit it. `fallback`
	 * coerces any other/unknown value to `undefined`. `optional` nests inside `fallback`, not
	 * outside, since a fallback's replacement value must match the wrapped schema's output type.
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
	battleTime: BattleTimeSchema,
	gameMode: v.optional(v.object({ name: v.string() })),
	team: v.array(PlayerSchema),
	opponent: v.array(PlayerSchema),
});

// ════════════════════════════════════════════ DERIVED ════════════════════════════════════════════

/** Cards in one deck; a Duel concatenates 2–3 decks into `cards`, so a longer array is the tell. */
const DECK_SIZE = 8;

/**
 * The cheap 1v1 gate run over the whole battlelog before full validation: exactly one `team` entry
 * whose `cards` is at most one deck. A Duel is also a single `team` entry, but concatenates 2–3
 * decks (16 or 24 cards) into `cards` — the card count, not `gameMode.name` (which varies across
 * duel variants), is the structural tell.
 *
 * `team` is declared before `battleTime` deliberately. `v.is` runs valibot with abort-early config
 * internally, and `v.object` checks entries in declaration order, stopping at the first issue. So a
 * 2v2 or Duel entry fails the cheap structural check before ever paying for the `Temporal` parse. A
 * malformed `battleTime` also counts as ineligible, so such an entry is skipped rather than
 * reported as schema drift — which is what makes the ordering (and abort-early itself) purely an
 * optimization: reordering the fields, or a future valibot internals change that stops
 * short-circuiting on the first issue, would cost speed, not correctness.
 */
const EligibleBattleSchema = v.object({
	team: v.pipe(
		v.array(v.object({ cards: v.pipe(v.array(v.unknown()), v.maxLength(DECK_SIZE)) })),
		v.length(1)
	),
	battleTime: BattleTimeSchema,
});

/** Whether a raw battlelog entry is a 1v1 worth fully validating. */
function isEligibleBattle(entry: unknown): boolean {
	return v.is(EligibleBattleSchema, entry);
}

/**
 * A stored lastBattle KV value. Reuses BattleTimeSchema, so parsing it also re-normalizes and
 * validates the stored value instead of trusting a raw `kv.get<string>` cast.
 */
const LastBattleSchema = BattleTimeSchema;

// ══════════════════════════════════════════════ ENV ══════════════════════════════════════════════

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

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

type Player = v.InferOutput<typeof PlayerSchema>;
type Battle = v.InferOutput<typeof BattleSchema>;
type Target = v.InferOutput<typeof TargetSchema>;
type Card = v.InferOutput<typeof CardSchema>;
/**
 * The levels `CardSchema` admits — the key type for the per-level lookup tables in `deck-image.ts`
 * and `discord.ts`.
 */
type EvolutionLevel = NonNullable<Card["evolutionLevel"]>;

export {
	BattleSchema,
	DECK_SIZE,
	isEligibleBattle,
	LastBattleSchema,
	TargetsEnvSchema,
	TokenEnvSchema,
};
export type { Battle, Card, EvolutionLevel, Player, Target };
