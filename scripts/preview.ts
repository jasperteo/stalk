/**
 * @module
 *
 * Renders {@link DECK} with the real renderer and writes it to `scripts/preview.png`, which git
 * ignores, for checking a layout change by eye. Edit `DECK` to see other cards, or change
 * `COLUMN_GAP` or `ROW_GAP` in `src/deck-image.ts` and run `pnpm preview` again.
 *
 * Every card in `DECK` has local art, so a run never touches the network. The script writes a file
 * and asserts nothing, so it is not part of `pnpm test`.
 */

import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * The icon URL every `Card` must carry. The renderer only reads it for a card without local art,
 * which no card in {@link DECK} is, so it is never fetched. `.invalid` is a reserved top-level
 * domain that never resolves.
 */
const DUMMY_ICON = "https://example.invalid/card.png";

/**
 * Real card ids, picked so one grid shows each kind of frame: an Evolution (`evolutionLevel` 1), a
 * Hero (`evolutionLevel` 2), a champion's hexagonal frame, and ordinary cards of several rarities.
 */
const DECK: Card[] = [
	{ id: 26_000_058, name: "Wall Breakers", evolutionLevel: 1, iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_062, name: "Magic Archer", evolutionLevel: 2, iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_099, name: "Goblinstein", iconUrls: { medium: DUMMY_ICON } },
	{ id: 28_000_015, name: "Barbarian Barrel", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_102, name: "Berserker", iconUrls: { medium: DUMMY_ICON } },
	{ id: 28_000_012, name: "Tornado", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_032, name: "Miner", iconUrls: { medium: DUMMY_ICON } },
	{ id: 27_000_004, name: "Bomb Tower", iconUrls: { medium: DUMMY_ICON } },
];

const OUTPUT_PATH = new URL("preview.png", import.meta.url);

const png = await renderDeckGrid(DECK);
await Deno.writeFile(OUTPUT_PATH, png);

log.success(`Wrote ${hl.entity("preview.png")} (${hl.value(`${String(png.length)}B`)})`);
