/**
 * @module
 *
 * Valibot schemas for the Clash Royale API responses the app reads and for its two env vars.
 *
 * The API schemas declare only the fields the app uses. `v.object` drops every other key, so a new
 * field in the API never breaks parsing, and parsed values carry only what the app needs. The notes
 * on individual fields describe what live battle logs, fetched through the RoyaleAPI proxy, actually
 * contain.
 */

import * as v from "valibot";

// ══════════════════════════════════════════ PRIMITIVES ═══════════════════════════════════════════

/** An absolute URL. Used for card art from the API and for each webhook in `TARGETS`. */
const UrlSchema = v.pipe(v.string(), v.url());

/**
 * A player tag in canonical form: uppercase, with a leading `#`. A `TARGETS` entry written as
 * `abc123` or `#ABC123` therefore reaches the same KV key and the same API request, and tags parsed
 * from battles have the same shape.
 */
const TagSchema = v.pipe(
	v.string(),
	v.transform((tag) => (tag.startsWith("#") ? tag : `#${tag}`)),
	v.toUpperCase()
);

/**
 * A battle timestamp, parsed into a `Temporal.Instant`. The API sends compact ISO 8601, such as
 * `20260925T194522.000Z`, which `Temporal.Instant.from` accepts. The parse doubles as the
 * validation, since `Temporal` rejects a malformed string and an impossible date such as February
 * 31 alike. Valibot's `iso*` actions can't replace it: their patterns require the extended form
 * with `-` and `:` separators, and as regexes they accept February 31.
 *
 * The output stays an `Instant` because `poll.ts` compares two of them. It becomes a string only
 * where one is needed: {@link serializeLastBattle} formats it for the KV write, because Deno KV
 * cannot store a `Temporal.Instant`, and the Discord payload gets one from `JSON.stringify`, which
 * calls `Temporal.Instant.prototype.toJSON`.
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
	 * The card's numeric id. Every card in `cards` and `supportCards` has one. The deck renderer uses
	 * it as the file name of the card's art in `images/`.
	 */
	id: v.number(),
	name: v.string(),
	/**
	 * The form the card was played in: `1` for its Evolution, `2` for its Hero. The API omits the
	 * field for a card played in its ordinary form. Any other value falls back to `undefined`, so a
	 * level the API adds later renders as the ordinary card instead of failing the whole battle.
	 *
	 * `optional` sits inside `fallback` because a fallback value must match the output type of the
	 * schema it wraps, and `undefined` is only part of that type once `optional` is.
	 */
	evolutionLevel: v.fallback(v.optional(v.picklist([1, 2])), undefined),
	/**
	 * The card's art on the CDN. `medium` is always present. `evolutionMedium` and `heroMedium`
	 * appear on cards that have those forms, whether or not this copy was played in one, and a card
	 * played at `evolutionLevel` 1 or 2 always carries the matching key. The renderer reads these
	 * URLs only for a card with no file in `images/`.
	 */
	iconUrls: v.object({
		medium: UrlSchema,
		evolutionMedium: v.optional(UrlSchema),
		heroMedium: v.optional(UrlSchema),
	}),
});

/**
 * What each `evolutionLevel` means to the rest of the app: the suffix on the card's art file in
 * `images/`, the `iconUrls` key the CDN fallback fetches, and the prefix `discord.ts` puts before
 * the card's name. Level 0 stands for an ordinary card, so every consumer looks a card up the same
 * way and none of them branches on whether it evolved.
 *
 * The `satisfies` clause requires an entry for every level {@link CardSchema} admits. A level added
 * to that picklist without an entry here fails to compile in this file. Without the check, the new
 * level would render the card's base art and print its bare name.
 */
const EVOLUTIONS = {
	0: { suffix: "", iconKey: "medium", prefix: "" },
	1: { suffix: "-evo", iconKey: "evolutionMedium", prefix: "Evo " },
	2: { suffix: "-hero", iconKey: "heroMedium", prefix: "Hero " },
} as const satisfies Record<
	EvolutionLevel | 0,
	{ suffix: string; iconKey: keyof Card["iconUrls"]; prefix: string }
>;

/**
 * The {@link EVOLUTIONS} entry for a card as it was played. A card with no `evolutionLevel` gets the
 * level 0 entry.
 */
function evolutionOf(card: Card) {
	return EVOLUTIONS[card.evolutionLevel ?? 0];
}

const PlayerSchema = v.object({
	tag: TagSchema,
	name: v.string(),
	crowns: v.number(),
	/**
	 * The trophy count before the battle and the change the battle made to it. The API sends the two
	 * independently, and either can be missing in any mode. Friendlies carry `startingTrophies`
	 * without `trophyChange`, and some Path of Legend battles carry only `trophyChange`. `discord.ts`
	 * shows a trophy row only when `startingTrophies` is present, and treats a missing `trophyChange`
	 * as 0.
	 */
	startingTrophies: v.optional(v.number()),
	trophyChange: v.optional(v.number()),
	/**
	 * Tower HP left when the battle ended. The API reports a destroyed king tower as 0, so the
	 * default of 0 only covers a missing field. It leaves destroyed princess towers out of the array:
	 * two entries when both stand, one after the opponent's first crown, and `null` once both are
	 * gone. The transform pads the array back to a pair, so a destroyed tower reads as 0 HP.
	 */
	kingTowerHitPoints: v.optional(v.number(), 0),
	princessTowersHitPoints: v.pipe(
		v.nullish(v.array(v.number()), []),
		v.transform((hp): [number, number] => [hp[0] ?? 0, hp[1] ?? 0])
	),
	/**
	 * The deck as played. That is 8 cards in a normal 1v1, but some modes send an empty array, for
	 * example `All_Random_Princess_Friendly`.
	 */
	cards: v.array(CardSchema),
	/** The tower troop: one card, or an empty array in modes that have none. */
	supportCards: v.array(CardSchema),
});

const BattleSchema = v.object({
	/**
	 * The API's battle category, such as `PvP`, `pathOfLegend` or `friendly`. The embed footer falls
	 * back to it when `gameMode` is missing.
	 */
	type: v.string(),
	battleTime: BattleTimeSchema,
	/**
	 * The specific mode, such as `Ladder` or `Ranked1v1_NewArena2`. Every battle in the logs has one.
	 * It stays optional so that a battle without it still posts, with `type` in the footer.
	 */
	gameMode: v.optional(v.object({ name: v.string() })),
	/**
	 * Exactly one player per side. As a tuple, `team[0]` is typed `Player` rather than `Player |
	 * undefined` under `noUncheckedIndexedAccess`, so `discord.ts` destructures both sides without a
	 * guard. `v.pipe(v.array(...), v.length(1))` would check the same thing at runtime but leave the
	 * type as `Player[]`.
	 *
	 * `strictTuple` rejects extra entries, where `v.tuple` would drop them silently and post a 2v2 as
	 * if it were a 1v1. A battle with an extra player fails validation instead and reports as
	 * `drifted`. {@link EligibleBattleSchema} filters out 2v2s before this schema runs, so this only
	 * fails if the two schemas ever disagree.
	 */
	team: v.strictTuple([PlayerSchema]),
	opponent: v.strictTuple([PlayerSchema]),
});

// ════════════════════════════════════════════ DERIVED ════════════════════════════════════════════

/**
 * The number of cards in one deck. A Duel puts two or three decks into a single `cards` array, 16
 * or 24 cards, so any longer array marks the entry as a Duel.
 *
 * @internal Exported for tests and their fixtures. Production code reads it only through
 *   {@link EligibleBattleSchema}.
 */
const DECK_SIZE = 8;

/**
 * The cheap check that decides which battle-log entries count as a 1v1. An eligible entry has
 * exactly one `team` player whose `cards` hold at most one deck, exactly one `opponent`, and a
 * valid `battleTime`. `latestBattle` scans the log with it and runs the full {@link BattleSchema}
 * only on the first entry that passes.
 *
 * What it rejects:
 *
 * - A 2v2, which has two players in `team` and in `opponent`.
 * - A Duel, which has one player per side but two or three decks in `cards`. The card count is the
 *   test; the mode name is never checked.
 * - An entry without exactly one `opponent`. It would otherwise pass here, fail `BattleSchema`'s
 *   tuple, and report as `drifted`. A drifted battle holds lastBattle in place and is retried every
 *   tick, and this one can never become valid, so it would block the player's newer battles for
 *   good. Rejected here, it is skipped like a 2v2. Only the length is checked, so a malformed
 *   opponent still reports as drift.
 *
 * An entry with an empty `cards` array passes. `All_Random_Princess_Friendly` sends those, and they
 * post with the text-only fallback because there is no deck to render.
 *
 * The field order is deliberate. `v.is` runs with `abortEarly`, and `v.object` checks keys in
 * declaration order and stops at the first issue, so a 2v2 or a Duel fails on `team` before the
 * `Temporal` parse in `battleTime` runs. The order only affects speed: an entry with a bad
 * `battleTime` is ineligible whichever field fails first.
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
 * Whether a raw battle-log entry passes {@link EligibleBattleSchema}. `false` covers 2v2s, Duels and
 * malformed entries alike, and the caller skips all of them.
 */
function isEligibleBattle(entry: unknown): boolean {
	return v.is(EligibleBattleSchema, entry);
}

/**
 * A lastBattle value read back from KV. It is {@link BattleTimeSchema} itself, so a stored value
 * parses into the same `Temporal.Instant` type a fetched battle carries, and the two compare
 * directly. It accepts both the compact form the API sends and the extended form
 * {@link serializeLastBattle} writes. A corrupt stored value fails to parse, which is how `poll.ts`
 * notices it and re-seeds.
 */
const LastBattleSchema = BattleTimeSchema;

/**
 * Formats an instant as the string stored under a lastBattle key, since Deno KV cannot store a
 * `Temporal.Instant`. The precision is fixed at milliseconds, so one instant always produces the
 * same string. `toString()` alone would drop `.000` from a whole second and give values of varying
 * length. The `/kv/last-battle` route and the log lines show these strings unchanged.
 */
function serializeLastBattle(instant: Temporal.Instant) {
	return instant.toString({ fractionalSecondDigits: 3 });
}

// ══════════════════════════════════════════════ ENV ══════════════════════════════════════════════

/**
 * `CR_API_TOKEN`: any non-empty string. An empty value is invalid, which `env.ts` logs at error
 * level, unlike an unset one.
 */
const TokenEnvSchema = v.pipe(v.string(), v.nonEmpty());

/** One tracked player: the tag to poll and the Discord webhook that receives their battles. */
const TargetSchema = v.object({
	tag: TagSchema,
	webhook: UrlSchema,
});

/**
 * The raw `TARGETS` value: a JSON array of {@link TargetSchema} objects. `v.parseJson` turns
 * malformed JSON into an ordinary validation issue, so `env.ts` handles it the same way as any
 * other invalid value.
 */
const TargetsEnvSchema = v.pipe(v.string(), v.parseJson(), v.array(TargetSchema));

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/** One side of a validated battle. */
type Player = v.InferOutput<typeof PlayerSchema>;
/** A validated 1v1 battle, as `latestBattle` returns it. */
type Battle = v.InferOutput<typeof BattleSchema>;
/** One entry of the validated `TARGETS` list. */
type Target = v.InferOutput<typeof TargetSchema>;
/** A validated card, from a deck or from `supportCards`. */
type Card = v.InferOutput<typeof CardSchema>;
/**
 * The `evolutionLevel` values {@link CardSchema} admits. Its one job is the `satisfies` clause on
 * {@link EVOLUTIONS}, so it is not exported.
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
