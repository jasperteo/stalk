import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * Dev-only preview tool: renders DECK and writes it next to this script for visual inspection. Edit
 * DECK below to whatever cards you want to preview. Rendering reads each tile from the local
 * `images/` mirror by card id (`<id>.png`/`<id>-evo.png`/`<id>-hero.png`), so a fully-local deck
 * never touches the network — but it's still not wired into `deno task test` (it writes a file and
 * isn't a hermetic assertion), so run it manually via `deno task preview`. To tune spacing, edit
 * COLUMN_GAP/ROW_GAP directly in deck-image.ts and rerun.
 *
 * The ids below are real (`cr-cards.json`), chosen to exercise every frame style in one grid: an
 * Evolution (`evolutionLevel: 1`), a Hero (`evolutionLevel: 2`), a champion's hexagonal frame, plus
 * a spread of common/rare/epic frames. `iconUrls.medium` is a throwaway placeholder the `Card` type
 * requires: it's only read on the CDN-fallback path (a card missing from `images/`), which a
 * fully-local deck never reaches, so it needs to be a valid URL but never resolves.
 */
const DUMMY_ICON = "https://example.invalid/card.png";

const DECK: Card[] = [
	{ id: 26_000_000, name: "Knight", evolutionLevel: 1, iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_027, name: "Dark Prince", evolutionLevel: 2, iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_069, name: "Skeleton King", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_103, name: "Boss Bandit", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_011, name: "Valkyrie", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_045, name: "Executioner", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_024, name: "Royal Giant", iconUrls: { medium: DUMMY_ICON } },
	{ id: 26_000_030, name: "Ice Spirit", iconUrls: { medium: DUMMY_ICON } },
];

const OUTPUT_PATH = new URL("preview.png", import.meta.url);

const png = await renderDeckGrid(DECK);
await Deno.writeFile(OUTPUT_PATH, png);

log.success(`Wrote ${hl.entity("preview.png")} (${hl.value(`${String(png.length)}B`)})`);
