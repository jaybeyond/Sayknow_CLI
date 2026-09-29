import { describe, expect, it } from "bun:test";
import { decodePng, renderSayoPose, SAYO_POSES } from "../src/components/sayo-sprite";
import { SAYO_SOURCE_PNG_BASE64 } from "../src/components/sayo-sprite-source";

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
