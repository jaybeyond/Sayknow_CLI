import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@sayknow-cli/tui";
import { WelcomeComponent } from "../src/modes/components/welcome";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

beforeAll(async () => {
	const theme = await getThemeByName("red-octopus");
	if (!theme) throw new Error("Failed to load red-octopus theme");
	setThemeInstance(theme);
});

describe("WelcomeComponent viewport sizing", () => {
	it("uses the full terminal width on wide initial forge viewports", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");
		const lines = welcome.render(200);

		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(200);
		}
	});

	it("degrades gracefully on tiny terminal widths", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii");

		expect(welcome.render(5).every(line => visibleWidth(line) <= 5)).toBe(true);
		expect(welcome.render(3)).toEqual([]);
		expect(welcome.render(24).every(line => visibleWidth(line) <= 24)).toBe(true);
	});

	it("fills available terminal rows while reserving the pinned composer and HUD", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 24,
			getReservedBottomRows: () => 6,
		});
		const lines = welcome.render(100);

		expect(lines).toHaveLength(18);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(100);
		}
		expect(lines.some(line => line.includes("Sayknow-CLI"))).toBe(true);
		expect(lines.some(line => line.includes("What's New"))).toBe(true);
	});

	it("integrates changelog highlights without overflowing narrow CJK content", () => {
		const welcome = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 16,
			getReservedBottomRows: () => 5,
			changelogMarkdown: [
				"## [1.2.3]",
				"",
				"### Fixed",
				"",
				"- 한국어와 English가 섞인 긴 업데이트 내용을 시작 화면 안에서 안전하게 줄입니다.",
				"- Added fullscreen startup framing.",
			].join("\n"),
		});
		const lines = welcome.render(60);

		expect(lines).toHaveLength(11);
		expect(lines.some(line => line.includes("한국어와 English"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("does not steal rows when the pinned composer already fills the viewport", () => {
		const hidden = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 5,
		});
		expect(hidden.render(80)).toEqual([]);

		const oneRow = new WelcomeComponent("1.2.3", "test-model", "test-provider", [], [], "ascii", {
			getViewportRows: () => 5,
			getReservedBottomRows: () => 4,
		});
		const lines = oneRow.render(80);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(80);
	});
});
