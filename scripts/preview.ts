/**
 * @module
 *
 * Dev-only preview tool: renders DECK and writes it next to this script for visual inspection. Edit
 * DECK below to whatever cards you want to preview. Rendering reads each tile from the local
 * `images/` mirror by card id (`<id>.png`/`<id>-evo.png`/`<id>-hero.png`), so a fully-local deck
 * never touches the network. But it's still not wired into `deno task test` (it writes a file and
 * isn't a hermetic assertion), so run it manually via `deno task preview`. To tune spacing, edit
 * COLUMN_GAP/ROW_GAP directly in deck-image.ts and rerun.
 */

import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * A throwaway placeholder the `Card` type requires. Only read on the CDN-fallback path (a card
 * missing from `images/`), which a fully-local deck never reaches. So it just needs to be a valid
 * URL, never one that actually resolves.
 */
const DUMMY_ICON = "https://example.invalid/card.png";

/**
 * Real card ids, chosen to exercise every frame style in one grid: an Evolution (`evolutionLevel:
 * 1`), a Hero (`evolutionLevel: 2`), a champion's hexagonal frame, plus a spread of
 * common/rare/epic frames.
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
