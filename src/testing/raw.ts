/**
 * @module
 *
 * Raw RGBA bitmap helpers shared by the image tests: a solid-color fixture and a pixel reader.
 */

import type { RawImage } from "@/tile.ts";

/** A `width`×`height` bitmap filled with one RGBA color. */
function solidRaw(width: number, height: number, rgba: readonly number[]): RawImage {
	const data = new Uint8Array(width * height * 4);

	for (let offset = 0; offset < data.length; offset += 4) {
		data.set(rgba, offset);
	}

	return { data, width, height };
}

/** The RGBA values of one pixel in a bitmap, for checking where bytes came from. */
function pixelAt({ data, width }: Pick<RawImage, "data" | "width">, x: number, y: number) {
	const offset = (y * width + x) * 4;

	return [...data.subarray(offset, offset + 4)];
}

export { pixelAt, solidRaw };
