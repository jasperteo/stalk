import { renderDeckGrid } from "@/deck-image.ts";
import { hl, log } from "@/log.ts";
import type { Card } from "@/schema.ts";

/**
 * Dev-only preview tool: renders DECK and writes it next to this script for visual inspection. Edit
 * DECK below to whatever cards you want to preview. Rendering fetches each card's real icon from
 * the CR CDN, so this isn't wired into `deno task test` (not hermetic, writes a file) — run
 * manually via `deno task preview`. To tune spacing, edit COLUMN_GAP/ROW_GAP directly in
 * deck-image.ts and rerun.
 */
const DECK: Card[] = [
	{
		name: "Mega Knight",
		evolutionLevel: 1,
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/O2NycChSNhn_UK9nqBXUhhC_lILkiANzPuJjtjoz0CE.png",
			evolutionMedium:
				"https://api-assets.clashroyale.com/cardevolutions/300/O2NycChSNhn_UK9nqBXUhhC_lILkiANzPuJjtjoz0CE.png",
		},
	},
	{
		name: "Magic Archer",
		evolutionLevel: 2,
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/Avli3W7BxU9HQ2SoLiXnBgGx25FoNXUSFm7OcAk68ek.png",
			heroMedium:
				"https://api-assets.clashroyale.com/cardheroes/300/Avli3W7BxU9HQ2SoLiXnBgGx25FoNXUSFm7OcAk68ek.png",
		},
	},
	{
		name: "Boss Bandit",
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/nuceG9o7rAyvyc7D3sp2QSiRYtSOEgraq0NJkDf729s.png",
		},
	},
	{
		name: "Ronin",
		// The API's real icon 404s; CARD_ART_HACK in deck-image.ts substitutes RoyaleAPI's art, so
		// this URL is never fetched. Left broken on purpose, to exercise the override.
		iconUrls: { medium: "https://api-assets.clashroyale.com/cards/300/ronin-404.png" },
	},
	{
		name: "The Log",
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/_iDwuDLexHPFZ_x4_a0eP-rxCS6vwWgTs6DLauwwoaY.png",
		},
	},
	{
		name: "Princess",
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/bAwMcqp9EKVIKH3ZLm_m0MqZFSG72zG-vKxpx8aKoVs.png",
			evolutionMedium:
				"https://api-assets.clashroyale.com/cardevolutions/300/bAwMcqp9EKVIKH3ZLm_m0MqZFSG72zG-vKxpx8aKoVs.png",
		},
	},
	{
		name: "Lumberjack",
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/E6RWrnCuk13xMX5OE1EQtLEKTZQV6B78d00y8PlXt6Q.png",
			evolutionMedium:
				"https://api-assets.clashroyale.com/cardevolutions/300/E6RWrnCuk13xMX5OE1EQtLEKTZQV6B78d00y8PlXt6Q.png",
		},
	},
	{
		name: "Cannon",
		iconUrls: {
			medium:
				"https://api-assets.clashroyale.com/cards/300/nZK1y-beLxO5vnlyUhK6-2zH2NzXJwqykcosqQ1cmZ8.png",
			evolutionMedium:
				"https://api-assets.clashroyale.com/cardevolutions/300/nZK1y-beLxO5vnlyUhK6-2zH2NzXJwqykcosqQ1cmZ8.png",
		},
	},
];

const OUTPUT_PATH = new URL("preview.png", import.meta.url);

const png = await renderDeckGrid(DECK);
await Deno.writeFile(OUTPUT_PATH, png);

log.success(`Wrote ${hl.entity("preview.png")} (${hl.value(`${String(png.length)}B`)})`);
