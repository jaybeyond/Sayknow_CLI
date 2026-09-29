/**
 * Sayo in text lines, through kitty graphics Unicode placeholders (Ghostty, kitty).
 *
 * Each pose is uploaded once as an image with a virtual placement (`U=1`). A line then
 * shows it by writing placeholder cells (U+10EEEE plus row/column diacritics) in a
 * foreground color that encodes the image id. The image lives in ordinary text: it
 * scrolls, redraws and clears with the transcript, and switching poses is a color change
 * on those cells rather than a new image.
 */
import { deflateSync } from "node:zlib";
import { renderSayoPose, type SayoPose, type SayoTint } from "./sayo-sprite";

const PLACEHOLDER = String.fromCodePoint(0x10eeee);

/** Kitty's row/column diacritics (rowcolumn-diacritics.txt), enough for small images. */
const DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
	0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
	0x036e, 0x036f,
].map(code => String.fromCodePoint(code));

/** Largest image this module can address in cells. */
export const SAYO_PLACEHOLDER_MAX_CELLS = DIACRITICS.length;

export interface SayoPlaceholderImages {
	columns: number;
	rows: number;
	/** Escape payload that uploads every pose and creates its virtual placement. */
	upload: string;
	/** Text row `row` of `pose`: placeholder cells colored with that pose's image id. */
	line(pose: SayoPose, row: number): string;
}

function kittyChunks(control: string, base64: string): string {
	const CHUNK = 4096;
	let out = "";
	for (let offset = 0, first = true; offset < base64.length || first; offset += CHUNK, first = false) {
		const chunk = base64.slice(offset, offset + CHUNK);
		const more = offset + CHUNK < base64.length ? 1 : 0;
		out += first ? `\x1b_G${control},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`;
	}
	return out;
}

/**
 * Prepare `poses` of Sayo in `tint`, `rows` cells tall and square in pixels. Image ids
 * are `idBase + index` and must fit in 24 bits (the id travels as an RGB color).
 */
export function prepareSayoPlaceholderImages(options: {
	tint: SayoTint;
	rows: number;
	cellWidthPx: number;
	cellHeightPx: number;
	poses: readonly SayoPose[];
	idBase: number;
}): SayoPlaceholderImages {
	const rows = Math.max(1, Math.min(SAYO_PLACEHOLDER_MAX_CELLS, Math.round(options.rows)));
	const side = rows * options.cellHeightPx;
	const columns = Math.max(1, Math.min(SAYO_PLACEHOLDER_MAX_CELLS, Math.round(side / options.cellWidthPx)));
	const width = columns * options.cellWidthPx;
	const height = rows * options.cellHeightPx;
	const left = Math.max(0, Math.floor((width - side) / 2));
	const ids = new Map<SayoPose, number>();
	let upload = "";
	for (const [index, pose] of options.poses.entries()) {
		const id = (options.idBase + index) & 0xffffff;
		ids.set(pose, id);
		const sprite = renderSayoPose(pose, options.tint, Math.min(side, width));
		const rgba = new Uint8Array(width * height * 4);
		const top = height - sprite.height;
		for (let y = 0; y < sprite.height; y++) {
			rgba.set(
				sprite.data.subarray(y * sprite.width * 4, (y + 1) * sprite.width * 4),
				((y + top) * width + left) * 4,
			);
		}
		const data = deflateSync(rgba).toString("base64");
		upload += `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
		upload += kittyChunks(`a=t,f=32,o=z,s=${width},v=${height},i=${id},q=2`, data);
		upload += `\x1b_Ga=p,U=1,i=${id},c=${columns},r=${rows},q=2\x1b\\`;
	}
	const rowCache = new Map<string, string>();
	return {
		columns,
		rows,
		upload,
		line(pose, row) {
			const id = ids.get(pose) ?? ids.values().next().value ?? options.idBase;
			const key = `${id}:${row}`;
			let text = rowCache.get(key);
			if (text === undefined) {
				const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
				let cells = "";
				for (let column = 0; column < columns; column++)
					cells += `${PLACEHOLDER}${DIACRITICS[row]}${DIACRITICS[column]}`;
				text = `${color}${cells}\x1b[39m`;
				rowCache.set(key, text);
			}
			return text;
		},
	};
}
