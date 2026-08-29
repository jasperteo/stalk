/**
 * @module
 *
 * Valibot schemas for the Clash Royale API shapes and the two env vars. Only the fields we actually
 * use are declared, and `v.object` strips unknown keys, so the API adding fields never breaks
 * parsing.
 */

import * as v from "valibot";

// ══════════════════════════════════════════ PRIMITIVES ═══════════════════════════════════════════

/** Any absolute URL: card art from the API, and the webhook in TARGETS. */
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
 * rejects invalid dates, which is why the parse doubles as the validation. There is no cheaper
 * check to swap in. Valibot's `iso*` actions don't apply: they all reject the compact form, and
 * even on the extended form they are regex shape checks that accept impossible dates like Feb 31.
 *
 * Yields the `Temporal.Instant` itself rather than a formatted string. Consumers want the instant
 * (`poll.ts` compares two of them), so formatting here would only mean re-parsing there.
 * Serializing is left to the two boundaries that need it: `poll.ts`'s KV write, which must format
 * explicitly because Deno KV can't structured-clone an `Instant`, and `discord.ts`'s webhook body,
 * where `JSON.stringify` reaches `Temporal.Instant.prototype.toJSON` on its own.
 */
const BattleTimeSchema = v.pipe(
	v.string(),
	v.rawTransform(({ dataset, addIssue, NEVER }) => {
		try {
			return Temporal.Instant.from(dataset.value);
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

/**
 * How each `evolutionLevel` manifests: the local-art filename suffix, the `iconUrls` variant the
 * CDN fallback prefers, and the display prefix. Level 0 stands for an ordinary card, which is what
 * lets consumers look a card up unconditionally instead of each branching on whether it evolved.
 *
 * One table rather than one per consumer. Adding a level to {@link CardSchema} fails to compile
 * here, at the single place that decides what a level means, instead of silently falling through to
 * base art in the renderer and a bare name in the Discord message.
 */
const EVOLUTIONS = {
	0: { suffix: "", iconKey: "medium", prefix: "" },
	1: { suffix: "-evo", iconKey: "evolutionMedium", prefix: "Evo " },
	2: { suffix: "-hero", iconKey: "heroMedium", prefix: "Hero " },
} as const satisfies Record<
	EvolutionLevel | 0,
	{ suffix: string; iconKey: keyof Card["iconUrls"]; prefix: string }
>;

/** The {@link EVOLUTIONS} entry for a card as it was played; an ordinary card resolves to level 0. */
function evolutionOf(card: Card) {
	return EVOLUTIONS[card.evolutionLevel ?? 0];
}

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
	 * Tower HP remaining at match end. The API omits destroyed towers, so we backfill them as 0. A
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
	/**
	 * Exactly one player per side, which {@link EligibleBattleSchema} already enforces before this
	 * schema ever runs. Declared as a tuple rather than `v.pipe(v.array(…), v.length(1))` so the
	 * _type_ carries it too: `v.length` is an action and leaves the output `Player[]`, whereas a
	 * tuple's index 0 is a known position, so `noUncheckedIndexedAccess` doesn't widen `team[0]` to
	 * `Player | undefined`. That is what lets `discord.ts` stop re-checking a guarantee it has.
	 *
	 * `strictTuple`, not `tuple`, unlike the `v.object`s here that strip unknown keys: a plain
	 * `v.tuple` would silently drop a second entry, posting a 2v2 as though it were a 1v1. Stripping
	 * an unknown _key_ is harmless forward-compatibility; stripping a _player_ is a wrong post.
	 * Rejecting instead surfaces it as `drifted`.
	 */
	team: v.strictTuple([PlayerSchema]),
	opponent: v.strictTuple([PlayerSchema]),
});

// ════════════════════════════════════════════ DERIVED ════════════════════════════════════════════

/**
 * Cards in one deck; a Duel concatenates 2–3 decks into `cards`, so a longer array is the tell.
 *
 * @internal Exported for tests only. Production reads it through {@link EligibleBattleSchema} in
 *   this file.
 */
const DECK_SIZE = 8;

/**
 * The cheap 1v1 gate run over the whole battlelog before full validation: exactly one `team` entry
 * whose `cards` is at most one deck, against exactly one `opponent`. A Duel is also a single `team`
 * entry, but concatenates 2–3 decks (16 or 24 cards) into `cards`. The card count, not
 * `gameMode.name` (which varies across duel variants), is the structural tell.
 *
 * The `opponent` check is what keeps {@link BattleSchema}'s one-per-side tuples from creating a
 * stuck state. Without it, an entry missing its opponent would pass this gate, win selection, then
 * fail full validation as `drifted`. That holds lastBattle in place and retries forever against a
 * shape that can never become valid. Checked here instead, such an entry is merely ineligible, so
 * the scan walks past it like a 2v2. It only reads the length, leaving the contents to
 * `BattleSchema`, so genuine drift inside an opponent still reports as drift.
 *
 * `team` and `opponent` are declared before `battleTime` deliberately. `v.is` runs valibot with
 * abort-early config internally, and `v.object` checks entries in declaration order, stopping at
 * the first issue. So a 2v2 or Duel entry fails the cheap structural check before ever paying for
 * the `Temporal` parse. A malformed `battleTime` also counts as ineligible, so such an entry is
 * skipped rather than reported as schema drift. That is what makes the ordering (and abort-early
 * itself) purely an optimization. Reordering the fields, or a future valibot internals change that
 * stops short-circuiting on the first issue, would cost speed, not correctness.
 */
const EligibleBattleSchema = v.object({
	team: v.pipe(
		v.array(v.object({ cards: v.pipe(v.array(v.unknown()), v.maxLength(DECK_SIZE)) })),
		v.length(1)
	),
	opponent: v.pipe(v.array(v.unknown()), v.length(1)),
	battleTime: BattleTimeSchema,
});

/**
 * Whether a raw battlelog entry is a 1v1 worth fully validating. See {@link EligibleBattleSchema}
 * for what passes and what a failure means.
 */
function isEligibleBattle(entry: unknown): boolean {
	return v.is(EligibleBattleSchema, entry);
}

/**
 * A stored lastBattle KV value. Reuses BattleTimeSchema, so the stored string parses into the same
 * `Temporal.Instant` a freshly fetched battle carries and the two compare directly, rather than
 * trusting a raw `kv.get<string>` cast. It also still validates: a corrupt stored value fails here,
 * which is what lets `readLastBattle` re-seed instead of re-posting forever.
 */
const LastBattleSchema = BattleTimeSchema;

/**
 * The write side of {@link LastBattleSchema}: formats an `Instant` into the string KV actually
 * stores, since KV can't structured-clone an `Instant` directly. Fixed `fractionalSecondDigits` so
 * the same instant always serializes to the same bytes. A read/write cycle never churns the stored
 * value, and `main.ts`'s lastBattle dump stays aligned.
 */
function serializeLastBattle(instant: Temporal.Instant) {
	return instant.toString({ fractionalSecondDigits: 3 });
}

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
 * The levels `CardSchema` admits. Its one use is guarding {@link EVOLUTIONS}, which is what makes a
 * level added here fail to compile until that table describes it.
 */
type EvolutionLevel = NonNullable<Card["evolutionLevel"]>;

export {
	BattleSchema,
	DECK_SIZE,
	evolutionOf,
	isEligibleBattle,
	LastBattleSchema,
	serializeLastBattle,
	TargetsEnvSchema,
	TokenEnvSchema,
};
export type { Battle, Card, Player, Target };
