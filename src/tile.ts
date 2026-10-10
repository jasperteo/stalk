/**
 * @module
 *
 * One card's pixels: raw RGBA bitmaps, trimming, shrinking, and the `.tile` file format.
 *
 * Card art is decoded and trimmed ahead of time by `scripts/tiles.ts`, which writes each result as a
 * `.tile` file. The renderer reads those files with {@link parseTile} and composites them, so it
 * never decodes a PNG. This module imports no image library: everything here works on plain
 * `Uint8Array` pixels, so it runs wherever the renderer does.
 */

// ═════════════════════════════════════════════ TYPES ═════════════════════════════════════════════

/** A decoded bitmap, row-major RGBA with no padding between rows. */
type RawImage = {
	data: Uint8Array;
	width: number;
	height: number;
};

/** The opaque region of a bitmap, as inclusive pixel coordinates. */
type Bounds = {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
};

/** A rectangle to copy out of a bitmap, in pixels. */
type Region = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/**
 * A trimmed card, ready to composite: its pixels from {@link cropRaw}, its size, and the number of
 * transparent rows it kept below the art. The renderer checks `bottomPadding` against the row
 * overlap.
 */
type Tile = {
	data: Uint8Array;
	width: number;
	height: number;
	bottomPadding: number;
};

// ═══════════════════════════════════════════ CONSTANTS ═══════════════════════════════════════════

/**
 * The alpha value at or below which a pixel counts as transparent when finding a card's art bounds.
 * With this threshold, 28 of the icons in `images/` trim 1 or 2 px tighter than with 0, because
 * their faint edge pixels don't count as art. The cell sizes were measured at this threshold, and
 * the widest tile is one of the 28, so changing it means running `pnpm tiles` and measuring again.
 */
const ALPHA_THRESHOLD = 8;
/** Bytes per pixel in every raw bitmap in this module: RGBA, unpremultiplied. */
const BYTES_PER_PIXEL = 4;

/**
 * The first four bytes of every `.tile` file: the ASCII text `STK1`. The digit is the format
 * version, so a future layout change becomes `STK2` and {@link parseTile} rejects the old files
 * with a clear error instead of misreading them.
 *
 * A `.tile` file is self-describing, with no manifest beside it:
 *
 * | Bytes | Content                                                    |
 * | ----- | ---------------------------------------------------------- |
 * | 0-3   | the magic, `STK1`                                          |
 * | 4-5   | `width`, uint16 big-endian                                 |
 * | 6-7   | `height`, uint16 big-endian                                |
 * | 8-9   | `bottomPadding`, uint16 big-endian                         |
 * | 10-   | `width * height * 4` bytes, row-major RGBA, no row padding |
 *
 * Each file carries its own size and padding, so there is no index to keep in sync with the files
 * and a file stands alone. That also suits serving the files as static assets later, where nothing
 * else has to be uploaded with them.
 */
const TILE_MAGIC = new TextEncoder().encode("STK1");
/** The size of a `.tile` header in bytes: the magic plus three uint16 fields. */
const TILE_HEADER_BYTES = 10;
/** The largest value a uint16 header field holds. */
const MAX_UINT16 = 65_535;

// ══════════════════════════════════════════ RAW BITMAPS ══════════════════════════════════════════

/**
 * Finds the bounding box of a bitmap's opaque pixels, those with alpha above
 * {@link ALPHA_THRESHOLD}. It scans rows from the top and from the bottom for `minY` and `maxY`,
 * then columns from the left and from the right, only within those rows, for `minX` and `maxX`.
 * Each scan stops at the first row or column with an opaque pixel, so it reads little more than the
 * margins.
 *
 * @returns The inclusive bounds, or `undefined` for a fully transparent bitmap.
 * @internal Exported for `scripts/tiles.ts` and tests.
 */
function scanArtBounds({ data, width, height }: RawImage): Bounds | undefined {
	const rowStride = width * BYTES_PER_PIXEL;

	const rowHasOpaque = (y: number) => {
		for (let x = 0, offset = y * rowStride + 3; x < width; x++, offset += BYTES_PER_PIXEL) {
			if ((data[offset] ?? 0) > ALPHA_THRESHOLD) return true;
		}
		return false;
	};
	const columnHasOpaque = (x: number, minY: number, maxY: number) => {
		for (
			let y = minY, offset = minY * rowStride + x * BYTES_PER_PIXEL + 3;
			y <= maxY;
			y++, offset += rowStride
		) {
			if ((data[offset] ?? 0) > ALPHA_THRESHOLD) return true;
		}
		return false;
	};

	let minY = -1;
	for (let y = 0; y < height; y++) {
		if (rowHasOpaque(y)) {
			minY = y;
			break;
		}
	}

	if (minY < 0) {
		return undefined;
	}

	let maxY = height - 1;
	for (; maxY > minY; maxY--) {
		if (rowHasOpaque(maxY)) break;
	}

	let minX = 0;
	for (; minX < width; minX++) {
		if (columnHasOpaque(minX, minY, maxY)) break;
	}

	let maxX = width - 1;
	for (; maxX > minX; maxX--) {
		if (columnHasOpaque(maxX, minY, maxY)) break;
	}

	return { minX, minY, maxX, maxY };
}

/**
 * Copies a rectangle out of a raw RGBA bitmap, one row at a time. A plain memory copy needs no
 * image library.
 *
 * The destination is a new `Uint8Array`, which is zero-filled. `subarray` silently shortens a range
 * that runs past the end of the source, so an out-of-bounds row would otherwise leave stale bytes
 * in the output if the array were not zeroed. The bounds check rules that out, and the zero fill
 * still covers a future caller whose region does not come from {@link scanArtBounds}.
 *
 * @returns The cropped pixels, packed at `region.width` pixels per row.
 * @throws When `region` has a negative coordinate or size, or extends past the source bitmap.
 * @internal Exported for tests.
 */
function cropRaw({ data, width }: RawImage, region: Region) {
	if (
		region.left < 0 ||
		region.top < 0 ||
		region.width < 0 ||
		region.height < 0 ||
		region.left + region.width > width ||
		(region.top + region.height) * width * BYTES_PER_PIXEL > data.length
	) {
		throw new Error(
			`Crop region ${String(region.left)},${String(region.top)} ${String(region.width)}x${String(region.height)} exceeds the ${String(width)}px-wide source bitmap`
		);
	}

	const rowBytes = region.width * BYTES_PER_PIXEL;
	const cropped = new Uint8Array(region.height * rowBytes);

	for (let y = 0; y < region.height; y++) {
		const start = ((region.top + y) * width + region.left) * BYTES_PER_PIXEL;
		cropped.set(data.subarray(start, start + rowBytes), y * rowBytes);
	}

	return cropped;
}

/**
 * Trims a decoded icon's transparent margin from the top, left and right, and keeps its bottom
 * edge. Every icon is drawn on the same 285×420 canvas, so keeping the canvas's bottom edge lines
 * the cards up the way the source art places them. Trimming the bottom as well would align each
 * card on its lowest opaque pixel, and a card whose frame reaches lower would then sit higher than
 * its neighbors. The tile keeps its native resolution, since scaling it up would blur it.
 *
 * @returns The trimmed tile, with `bottomPadding` set to the transparent rows kept below the art. A
 *   fully transparent bitmap comes back whole, with `bottomPadding` equal to its height; cropping
 *   it to an empty region would give the compositor a zero-size input and fail the render.
 */
function trimRaw(raw: RawImage): Tile {
	const { width, height } = raw;
	const bounds = scanArtBounds(raw);

	// No card art is fully transparent, but a blank tile must not fail the render.
	if (bounds === undefined) {
		return {
			data: cropRaw(raw, { left: 0, top: 0, width, height }),
			width,
			height,
			bottomPadding: height,
		};
	}

	const { minX, minY, maxX, maxY } = bounds;
	const region = { left: minX, top: minY, width: maxX - minX + 1, height: height - minY };

	return {
		data: cropRaw(raw, region),
		width: region.width,
		height: region.height,
		bottomPadding: height - 1 - maxY,
	};
}

/**
 * Scales a bitmap down, keeping its aspect ratio, until it fits inside `maxWidth`×`maxHeight`: the
 * equivalent of an image library's "fit inside" resize, for oversized CDN art. That never happens
 * with the current art, since the CDN's icons share the 285×420 canvas of the files in `images/`,
 * so this is a safety net for a future card, not a hot path. The caller re-trims the result with
 * {@link trimRaw}, because shrinking moves the art's edges.
 *
 * The scale is `min(maxWidth / width, maxHeight / height)`, and each target dimension is `max(1,
 * min(max, round(dimension * scale)))`. Each target pixel is the area average of the source
 * footprint it covers, a box filter in which a source pixel the footprint only partly covers counts
 * in proportion to the covered area. Colors are weighted by alpha, which is the same as
 * premultiplying, averaging and unpremultiplying, so the transparent black around the art does not
 * darken its edges. The output alpha is the plain area average.
 *
 * @returns `raw` itself, the same object, when it already fits; otherwise a new, smaller bitmap.
 */
function shrinkToFit(raw: RawImage, maxWidth: number, maxHeight: number): RawImage {
	const { data, width, height } = raw;

	if (width <= maxWidth && height <= maxHeight) {
		return raw;
	}

	const scale = Math.min(maxWidth / width, maxHeight / height);
	const targetWidth = Math.max(1, Math.min(maxWidth, Math.round(width * scale)));
	const targetHeight = Math.max(1, Math.min(maxHeight, Math.round(height * scale)));
	const stepX = width / targetWidth;
	const stepY = height / targetHeight;
	const out = new Uint8Array(targetWidth * targetHeight * BYTES_PER_PIXEL);

	for (let ty = 0; ty < targetHeight; ty++) {
		const top = ty * stepY;
		const bottom = top + stepY;

		for (let tx = 0; tx < targetWidth; tx++) {
			const left = tx * stepX;
			const right = left + stepX;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let area = 0;

			for (let y = Math.floor(top); y < Math.min(height, Math.ceil(bottom)); y++) {
				const coverY = Math.min(y + 1, bottom) - Math.max(y, top);

				for (let x = Math.floor(left); x < Math.min(width, Math.ceil(right)); x++) {
					const weight = coverY * (Math.min(x + 1, right) - Math.max(x, left));
					const offset = (y * width + x) * BYTES_PER_PIXEL;
					const alpha = data[offset + 3] ?? 0;

					r += (data[offset] ?? 0) * alpha * weight;
					g += (data[offset + 1] ?? 0) * alpha * weight;
					b += (data[offset + 2] ?? 0) * alpha * weight;
					a += alpha * weight;
					area += weight;
				}
			}

			const outOffset = (ty * targetWidth + tx) * BYTES_PER_PIXEL;
			if (a > 0) {
				out[outOffset] = Math.round(r / a);
				out[outOffset + 1] = Math.round(g / a);
				out[outOffset + 2] = Math.round(b / a);
			}
			out[outOffset + 3] = Math.round(a / area);
		}
	}

	return { data: out, width: targetWidth, height: targetHeight };
}

// ═════════════════════════════════════════ TILE FILES ════════════════════════════════════════════

/**
 * Encodes a tile as a `.tile` file; the layout is documented on {@link TILE_MAGIC}.
 *
 * @returns A new array holding the header followed by the pixels.
 * @throws When a dimension or the padding exceeds 65,535, or `data` is not `width * height * 4`
 *   bytes long.
 * @internal Exported for `scripts/tiles.ts` and tests.
 */
function serializeTile({ data, width, height, bottomPadding }: Tile) {
	for (const value of [width, height, bottomPadding]) {
		if (!Number.isInteger(value) || value < 0 || value > MAX_UINT16) {
			throw new Error(`Tile dimension ${String(value)} does not fit in a uint16`);
		}
	}

	if (data.length !== width * height * BYTES_PER_PIXEL) {
		throw new Error(
			`Tile data is ${String(data.length)} bytes, expected ${String(width * height * BYTES_PER_PIXEL)} for ${String(width)}x${String(height)}`
		);
	}

	const bytes = new Uint8Array(TILE_HEADER_BYTES + data.length);
	const view = new DataView(bytes.buffer);

	bytes.set(TILE_MAGIC, 0);
	view.setUint16(4, width);
	view.setUint16(6, height);
	view.setUint16(8, bottomPadding);
	bytes.set(data, TILE_HEADER_BYTES);

	return bytes;
}

/**
 * Decodes a `.tile` file. The returned `data` is a `subarray` view of `bytes`, not a copy, so it
 * stays valid only as long as `bytes` is left unmodified.
 *
 * @throws When the buffer is shorter than the header, does not start with the `STK1` magic, or its
 *   body is not exactly `width * height * 4` bytes long.
 */
function parseTile(bytes: Uint8Array): Tile {
	if (bytes.length < TILE_HEADER_BYTES) {
		throw new Error(
			`Tile file is ${String(bytes.length)} bytes, shorter than its ${String(TILE_HEADER_BYTES)}-byte header`
		);
	}

	if (!TILE_MAGIC.every((byte, i) => bytes[i] === byte)) {
		throw new Error("Tile file does not start with the STK1 magic");
	}

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint16(4);
	const height = view.getUint16(6);
	const bottomPadding = view.getUint16(8);
	const expected = width * height * BYTES_PER_PIXEL;
	const body = bytes.length - TILE_HEADER_BYTES;

	if (body !== expected) {
		throw new Error(
			`Tile file body is ${String(body)} bytes, expected ${String(expected)} for ${String(width)}x${String(height)}`
		);
	}

	return { data: bytes.subarray(TILE_HEADER_BYTES), width, height, bottomPadding };
}

export { BYTES_PER_PIXEL, parseTile, shrinkToFit, trimRaw };

/** @internal Exported for `scripts/tiles.ts` and tests. */
export { scanArtBounds, serializeTile };

/** @internal Exported for tests. */
export { ALPHA_THRESHOLD, cropRaw };

export type { RawImage, Tile };
