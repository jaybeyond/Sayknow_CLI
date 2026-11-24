import { describe, expect, it } from "bun:test";
import { defaultThemes } from "../src/modes/theme/defaults";

type ThemeJson = { vars?: Record<string, unknown>; colors: Record<string, unknown>; export?: { pageBg?: string } };

function resolveHex(value: unknown, vars: Record<string, unknown>): string {
	let current = value;
	for (let depth = 0; typeof current === "string" && !current.startsWith("#") && depth < 10; depth++) {
		current = vars[current];
	}
	if (typeof current !== "string" || !/^#[0-9a-f]{6}$/i.test(current)) {
		throw new Error(`unresolved color ${String(value)}`);
	}
	return current;
}

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map(i => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("bundled theme contrast", () => {
	for (const [name, raw] of Object.entries(defaultThemes)) {
		it(`${name}: dim and muted text reach 4.5:1 against the page and the composer band`, () => {
			const theme = raw as ThemeJson;
			const vars = theme.vars ?? {};
			expect(theme.export?.pageBg).toMatch(/^#[0-9a-f]{6}$/i);
			const backgrounds = [theme.export!.pageBg!, resolveHex(theme.colors.userMessageBg, vars)];
			for (const background of backgrounds) {
				for (const token of ["dim", "muted"]) {
					expect(contrast(resolveHex(theme.colors[token], vars), background)).toBeGreaterThanOrEqual(4.5);
				}
			}
		});
	}
});
