import { describe, expect, it } from "bun:test";
import { inflateSync } from "node:zlib";
import { prepareSayoPlaceholderImages } from "../src/components/sayo-placeholder";
import { decodePng, renderSayoPose, SAYO_POSES } from "../src/components/sayo-sprite";
import { SAYO_SOURCE_PNG_BASE64 } from "../src/components/sayo-sprite-source";
import { visibleWidth } from "../src/utils";

describe("Sayo sprite", () => {
	it("decodes the embedded source image", () => {
		const image = decodePng(Buffer.from(SAYO_SOURCE_PNG_BASE64, "base64"));
		expect(image.width).toBe(200);
		expect(image.height).toBe(200);
		expect(image.data.length).toBe(200 * 200 * 4);
		// Transparent corner, opaque middle.
		expect(image.data[3]).toBe(0);
		expect(image.data[(100 * 200 + 100) * 4 + 3]).toBe(255);
	});

	it("renders every pose at the requested size, each different from the rest pose", () => {
		const base = renderSayoPose("base", "orange", 40);
		expect(base.data.length).toBe(40 * 40 * 4);
		for (const pose of SAYO_POSES) {
			if (pose === "base") continue;
			expect(Buffer.from(renderSayoPose(pose, "orange", 40).data).equals(Buffer.from(base.data))).toBe(false);
		}
	});

	it("tints by hue: red and blue keep the shape and move the color", () => {
		const average = (tint: "orange" | "red" | "blue") => {
			const { data } = renderSayoPose("base", tint, 32);
			let r = 0;
			let b = 0;
			let n = 0;
			for (let i = 0; i < data.length; i += 4) {
				if (data[i + 3]! < 200) continue;
				r += data[i]!;
				b += data[i + 2]!;
				n += 1;
			}
			return { r: r / n, b: b / n, n };
		};
		const orange = average("orange");
		const blue = average("blue");
		const red = average("red");
		expect(orange.r).toBeGreaterThan(orange.b * 2);
		expect(blue.b).toBeGreaterThan(blue.r * 1.5);
		expect(red.r).toBeGreaterThan(red.b * 2);
		expect(Math.abs(blue.n - orange.n)).toBeLessThan(orange.n * 0.02);
	});
});

describe("Sayo placeholder images", () => {
	const images = prepareSayoPlaceholderImages({
		tint: "orange",
		rows: 5,
		cellWidthPx: 9,
		cellHeightPx: 18,
		poses: ["base", "danceL"],
		idBase: 0x535901,
	});

	it("uploads each pose once with a virtual placement sized in cells", () => {
		expect(images.rows).toBe(5);
		expect(images.columns).toBe(10);
		expect(images.upload.match(/a=t,f=32,o=z,s=90,v=90,i=\d+/g)).toHaveLength(2);
		expect(images.upload).toContain(`a=p,U=1,i=${0x535901},c=10,r=5`);
		expect(images.upload).toContain(`a=p,U=1,i=${0x535902},c=10,r=5`);
		const first = images.upload.slice(images.upload.indexOf("\x1b_Ga=t,"), images.upload.indexOf("\x1b_Ga=p,U=1"));
		const payload = [...first.matchAll(/\x1b_G[^;\x1b]*;([^\x1b]*)\x1b\\/g)].map(match => match[1]).join("");
		expect(inflateSync(Buffer.from(payload, "base64")).length).toBe(90 * 90 * 4);
	});

	it("writes rows as placeholder cells whose color is the pose's image id", () => {
		const row = images.line("base", 0);
		expect(visibleWidth(row)).toBe(10);
		expect(row.startsWith("\x1b[38;2;83;89;1m")).toBe(true);
		expect(images.line("danceL", 0).startsWith("\x1b[38;2;83;89;2m")).toBe(true);
		// Rows differ by their row diacritic.
		expect(images.line("base", 1)).not.toBe(row);
		expect(visibleWidth(images.line("base", 4))).toBe(10);
	});
});
