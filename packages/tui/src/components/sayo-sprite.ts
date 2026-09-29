/**
 * Sayo sprite: the pet drawn from the Sayo mascot image instead of the 16×16 pixel grid,
 * for terminals with the kitty graphics protocol (Ghostty, kitty, WezTerm).
 *
 * Every pose is one image transformed: a tilt about the tentacle line (dance, glance),
 * squash and stretch (the "yay" beat), eyelids painted over the eyes (blink) and tears
 * below them (the sob). Colors are hue shifts of the orange original, so red and blue
 * keep the same shading. Nothing here touches the network or the file system; the source
 * PNG is embedded and decoded once.
 */
import { inflateSync } from "node:zlib";
import { SAYO_SOURCE_PNG_BASE64 } from "./sayo-sprite-source";

export type SayoPose = "base" | "gazeL" | "gazeR" | "flicker" | "flex" | "danceL" | "danceR" | "cry1" | "cry2" | "cry3";

export type SayoTint = "orange" | "red" | "blue";

/** Straight (non-premultiplied) RGBA pixels. */
export interface RgbaImage {
	width: number;
	height: number;
	data: Uint8Array;
}

// ── PNG decoding (8-bit RGB/RGBA, non-interlaced: what Bun.Image writes) ──────────────

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = 0;
	const idat: Uint8Array[] = [];
	while (offset < bytes.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		const body = bytes.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
			const depth = body[8];
			colorType = body[9]!;
			if (depth !== 8 || (colorType !== 6 && colorType !== 2) || body[12] !== 0) {
				throw new Error(`Unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${body[12]})`);
			}
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const pixels = new Uint8Array(width * height * channels);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[src + x]!;
			const left = x >= channels ? pixels[dst + x - channels]! : 0;
			const up = y > 0 ? pixels[dst - stride + x]! : 0;
			const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels]! : 0;
			pixels[dst + x] =
				(filter === 0
					? value
					: filter === 1
						? value + left
						: filter === 2
							? value + up
							: filter === 3
								? value + ((left + up) >> 1)
								: value + paeth(left, up, upLeft)) & 0xff;
		}
	}
	if (channels === 4) return { width, height, data: pixels };
	const data = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
		data[j] = pixels[i]!;
		data[j + 1] = pixels[i + 1]!;
		data[j + 2] = pixels[i + 2]!;
		data[j + 3] = 255;
	}
	return { width, height, data };
}

// ── Source: decoded once, cropped to the octopus ─────────────────────────────────────

interface SayoSource {
	/** Premultiplied RGBA floats of the cropped octopus. */
	pixels: Float32Array;
	width: number;
	height: number;
}

let cachedSource: SayoSource | undefined;

function sayoSource(): SayoSource {
	if (cachedSource) return cachedSource;
	const image = decodePng(Buffer.from(SAYO_SOURCE_PNG_BASE64, "base64"));
	let minX = image.width;
	let minY = image.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if (image.data[(y * image.width + x) * 4 + 3]! < 24) continue;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	// Square crop around the octopus, so every pose shares one box.
	const side = Math.max(maxX - minX + 1, maxY - minY + 1);
	const originX = Math.round((minX + maxX + 1 - side) / 2);
	const originY = Math.round((minY + maxY + 1 - side) / 2);
	const pixels = new Float32Array(side * side * 4);
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const sx = originX + x;
			const sy = originY + y;
			if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
			const i = (sy * image.width + sx) * 4;
			const alpha = image.data[i + 3]! / 255;
			const o = (y * side + x) * 4;
			pixels[o] = (image.data[i]! / 255) * alpha;
			pixels[o + 1] = (image.data[i + 1]! / 255) * alpha;
			pixels[o + 2] = (image.data[i + 2]! / 255) * alpha;
			pixels[o + 3] = alpha;
		}
	}
	cachedSource = { pixels, width: side, height: side };
	return cachedSource;
}

/** Area-average downscale (premultiplied), so small sizes stay smooth instead of aliased. */
function downscale(source: SayoSource, size: number): SayoSource {
	const out = new Float32Array(size * size * 4);
	const ratio = source.width / size;
	for (let y = 0; y < size; y++) {
		const y0 = y * ratio;
		const y1 = (y + 1) * ratio;
		for (let x = 0; x < size; x++) {
			const x0 = x * ratio;
			const x1 = (x + 1) * ratio;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let weight = 0;
			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
					const i = (sy * source.width + sx) * 4;
					r += source.pixels[i]! * w;
					g += source.pixels[i + 1]! * w;
					b += source.pixels[i + 2]! * w;
					a += source.pixels[i + 3]! * w;
					weight += w;
				}
			}
			const o = (y * size + x) * 4;
			out[o] = r / weight;
			out[o + 1] = g / weight;
			out[o + 2] = b / weight;
			out[o + 3] = a / weight;
		}
	}
	return { pixels: out, width: size, height: size };
}

function sampleBilinear(source: SayoSource, x: number, y: number, out: Float32Array): void {
	const fx = x - 0.5;
	const fy = y - 0.5;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const tx = fx - x0;
	const ty = fy - y0;
	out.fill(0);
	for (const [dx, dy, w] of [
		[0, 0, (1 - tx) * (1 - ty)],
		[1, 0, tx * (1 - ty)],
		[0, 1, (1 - tx) * ty],
		[1, 1, tx * ty],
	] as const) {
		const sx = x0 + dx;
		const sy = y0 + dy;
		if (w === 0 || sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
		const i = (sy * source.width + sx) * 4;
		out[0] += source.pixels[i]! * w;
		out[1] += source.pixels[i + 1]! * w;
		out[2] += source.pixels[i + 2]! * w;
		out[3] += source.pixels[i + 3]! * w;
	}
}

// ── Poses ────────────────────────────────────────────────────────────────────────────

/**
 * Eye centers and radius in the cropped source, as fractions of its side (measured on
 * sayo-logo.png: glossy black eyes either side of the smile).
 */
const EYES = [
	{ x: 0.297, y: 0.438 },
	{ x: 0.644, y: 0.441 },
] as const;
/** Half the measured eye height (0.13 of the side), so a lid covers the whole glossy eye. */
const EYE_RADIUS = 0.066;

interface PoseTransform {
	/** Tilt in degrees about the tentacle line (positive leans right). */
	tilt: number;
	scaleX: number;
	scaleY: number;
	/** Horizontal shift as a fraction of the box. */
	shiftX: number;
	blink: boolean;
	/** Pupil glance: -1 left, +1 right. */
	glance: number;
	/** Tear progress 1..3, 0 for none. */
	tear: number;
}

const POSES: Record<SayoPose, PoseTransform> = {
	base: { tilt: 0, scaleX: 1, scaleY: 1, shiftX: 0, blink: false, glance: 0, tear: 0 },
	gazeL: { tilt: -3, scaleX: 1, scaleY: 1, shiftX: 0, blink: false, glance: -1, tear: 0 },
	gazeR: { tilt: 3, scaleX: 1, scaleY: 1, shiftX: 0, blink: false, glance: 1, tear: 0 },
	flicker: { tilt: 0, scaleX: 1, scaleY: 1, shiftX: 0, blink: true, glance: 0, tear: 0 },
	flex: { tilt: 0, scaleX: 1.07, scaleY: 0.92, shiftX: 0, blink: false, glance: 0, tear: 0 },
	danceL: { tilt: -9, scaleX: 1, scaleY: 1.02, shiftX: -0.04, blink: false, glance: 0, tear: 0 },
	danceR: { tilt: 9, scaleX: 1, scaleY: 1.02, shiftX: 0.04, blink: false, glance: 0, tear: 0 },
	cry1: { tilt: 0, scaleX: 1, scaleY: 1, shiftX: 0, blink: true, glance: 0, tear: 1 },
	cry2: { tilt: 0, scaleX: 1, scaleY: 1, shiftX: 0, blink: true, glance: 0, tear: 2 },
	cry3: { tilt: 0, scaleX: 1, scaleY: 1, shiftX: 0, blink: true, glance: 0, tear: 3 },
};

/** The box keeps a margin so tilted and squashed poses are not clipped. */
const POSE_MARGIN = 0.07;
/** Pivot for tilt and squash: the tentacle line, near the bottom of the octopus. */
const PIVOT_Y = 0.86;

const TEAR_RGB = [0.72, 0.9, 1] as const;
const LID_DARK = [0.13, 0.08, 0.07] as const;

/**
 * Map a pixel of the pose into source coordinates (fractions of the source side).
 * Returns the inverse of: shift ∘ tilt ∘ squash, all about the pivot.
 */
function inversePose(pose: PoseTransform, u: number, v: number): [number, number] {
	// Box → unmargined sprite space.
	let x = (u - POSE_MARGIN) / (1 - 2 * POSE_MARGIN) - pose.shiftX;
	let y = (v - POSE_MARGIN) / (1 - 2 * POSE_MARGIN);
	const px = 0.5;
	const py = PIVOT_Y;
	const angle = (-pose.tilt * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const rx = (x - px) * cos - (y - py) * sin;
	const ry = (x - px) * sin + (y - py) * cos;
	x = px + rx / pose.scaleX;
	y = py + ry / pose.scaleY;
	return [x, y];
}

/** Render one pose, tinted, into a `size`×`size` straight-RGBA image. */
export function renderSayoPose(pose: SayoPose, tint: SayoTint, size: number): RgbaImage {
	const transform = POSES[pose];
	// Work at up to 3× and area-average down: smooth edges, crisp eyes. Past the source's
	// own resolution supersampling adds nothing but time.
	const sourceSide = sayoSource().width;
	const work = Math.max(8, Math.min(size * 3, Math.max(size, Math.ceil(sourceSide / (1 - 2 * POSE_MARGIN)))));
	const source = downscale(sayoSource(), Math.min(sourceSide, Math.round(work * (1 - 2 * POSE_MARGIN))));
	const side = source.width;
	const sample = new Float32Array(4);
	const bodyAbove = new Float32Array(4);
	const canvas = new Float32Array(work * work * 4);
	for (let y = 0; y < work; y++) {
		for (let x = 0; x < work; x++) {
			const [su, sv] = inversePose(transform, (x + 0.5) / work, (y + 0.5) / work);
			let lx = su;
			const ly = sv;
			let eyeDistance = Number.POSITIVE_INFINITY;
			let eyeIndex = -1;
			for (let e = 0; e < EYES.length; e++) {
				const d = Math.hypot((su - EYES[e]!.x) / EYE_RADIUS, (sv - EYES[e]!.y) / EYE_RADIUS);
				if (d < eyeDistance) {
					eyeDistance = d;
					eyeIndex = e;
				}
			}
			const eye = EYES[eyeIndex]!;
			const inEye = eyeDistance <= 1.25;
			if (inEye && transform.glance !== 0 && !transform.blink) lx = su - transform.glance * EYE_RADIUS * 0.3;
			sampleBilinear(source, lx * side, ly * side, sample);
			if (
				inEye &&
				(transform.blink ||
					(transform.glance !== 0 && Math.hypot((lx - eye.x) / EYE_RADIUS, (ly - eye.y) / EYE_RADIUS) > 1.25))
			) {
				// Skin from just above the eye covers it; a blink adds a closed-lid line.
				sampleBilinear(source, su * side, (eye.y - EYE_RADIUS * 2.1) * side, bodyAbove);
				sample.set(bodyAbove);
				const lid =
					transform.blink && Math.abs((sv - eye.y - EYE_RADIUS * 0.15) / EYE_RADIUS) < 0.22 && eyeDistance <= 1.05;
				if (lid) {
					sample[0] = LID_DARK[0] * sample[3]!;
					sample[1] = LID_DARK[1] * sample[3]!;
					sample[2] = LID_DARK[2] * sample[3]!;
				}
			}
			if (transform.tear > 0) {
				const outer = eyeIndex === 0 ? -1 : 1;
				const tx = eye.x + outer * EYE_RADIUS * 0.9;
				const ty = eye.y + EYE_RADIUS * (1.2 + transform.tear * 0.8);
				const t = Math.hypot((su - tx) / (EYE_RADIUS * 0.45), (sv - ty) / (EYE_RADIUS * 0.6));
				if (t <= 1 && sample[3]! > 0.5) {
					sample[0] = TEAR_RGB[0];
					sample[1] = TEAR_RGB[1];
					sample[2] = TEAR_RGB[2];
					sample[3] = 1;
				}
			}
			canvas.set(sample, (y * work + x) * 4);
		}
	}
	const scaled = downscale({ pixels: canvas, width: work, height: work }, size);
	const data = new Uint8Array(size * size * 4);
	for (let i = 0; i < size * size; i++) {
		const a = scaled.pixels[i * 4 + 3]!;
		if (a <= 0.002) continue;
		const [r, g, b] = tintRgb(
			scaled.pixels[i * 4]! / a,
			scaled.pixels[i * 4 + 1]! / a,
			scaled.pixels[i * 4 + 2]! / a,
			tint,
		);
		data[i * 4] = Math.round(Math.min(1, r) * 255);
		data[i * 4 + 1] = Math.round(Math.min(1, g) * 255);
		data[i * 4 + 2] = Math.round(Math.min(1, b) * 255);
		data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
	}
	return { width: size, height: size, data };
}

// ── Tint ─────────────────────────────────────────────────────────────────────────────

/** Hue shift in degrees from Sayo's orange; neutral pixels (eyes, highlights) are unaffected. */
const TINT_HUE: Record<SayoTint, number> = { orange: 0, red: -16, blue: 184 };
const TINT_SATURATION: Record<SayoTint, number> = { orange: 1, red: 1.05, blue: 0.95 };

function tintRgb(r: number, g: number, b: number, tint: SayoTint): [number, number, number] {
	if (tint === "orange") return [r, g, b];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	if (delta < 0.05) return [r, g, b];
	let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	hue = (hue * 60 + TINT_HUE[tint] + 360) % 360;
	const saturation = Math.min(1, (delta / max) * TINT_SATURATION[tint]);
	const value = max;
	const c = value * saturation;
	const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
	const m = value - c;
	const [r1, g1, b1] =
		hue < 60
			? [c, x, 0]
			: hue < 120
				? [x, c, 0]
				: hue < 180
					? [0, c, x]
					: hue < 240
						? [0, x, c]
						: hue < 300
							? [x, 0, c]
							: [c, 0, x];
	return [r1 + m, g1 + m, b1 + m];
}

/** Every pose the pet state machine names. */
export const SAYO_POSES = Object.keys(POSES) as SayoPose[];
