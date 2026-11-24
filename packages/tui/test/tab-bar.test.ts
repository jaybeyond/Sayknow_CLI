import { describe, expect, it } from "bun:test";
import { TabBar, type TabBarTheme } from "@sayknow-cli/tui/components/tab-bar";
import { visibleWidth } from "@sayknow-cli/tui/utils";

const ansiTheme: TabBarTheme = {
	label: text => text,
	activeTab: text => `\x1b[30;46m${text}\x1b[0m`,
	inactiveTab: text => `\x1b[37m${text}\x1b[0m`,
	hint: text => text,
};

describe("TabBar", () => {
	it("wraps without producing style-only lines or duplicate active highlights", () => {
		const tabs = [
			{ id: "display", label: "Display" },
			{ id: "agent", label: "Agent" },
			{ id: "input", label: "Input" },
			{ id: "tools", label: "Tools" },
			{ id: "config", label: "Config" },
			{ id: "services", label: "Services" },
			{ id: "bash", label: "Bash" },
			{ id: "lsp", label: "LSP" },
			{ id: "ttsr", label: "TTSR" },
			{ id: "plugins", label: "Plugins" },
		];
		const tabBar = new TabBar("Settings", tabs, ansiTheme, 8);

		const lines = tabBar.render(55);
		expect(lines.length > 1).toBeTruthy();

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(55);
			expect(visibleWidth(line)).toBeGreaterThan(0);
			expect(/^\x1b\[[0-9;]*m+$/.test(line)).toBe(false);
		}

		const rendered = lines.join("\n");
		const activeHighlights = rendered.match(/\x1b\[30;46m/g) ?? [];
		expect(activeHighlights.length).toBe(1);
	});

	it("keeps the hint on the last tab row and drops it rather than give it a row of its own", () => {
		const tabs = [
			{ id: "a", label: "Alpha" },
			{ id: "b", label: "Beta" },
		];
		const theme = { ...ansiTheme, hintText: "Tab to switch" };
		const plain = (lines: string[]) => lines.map(line => Bun.stripANSI(line).trimEnd());

		expect(plain(new TabBar("Settings", tabs, theme).render(80))).toEqual([
			"Settings:   Alpha   Beta   Tab to switch",
		]);
		expect(plain(new TabBar("Settings", tabs, theme).render(26))).toEqual(["Settings:   Alpha   Beta"]);
	});

	it("never renders a row of only spacing at narrow widths", () => {
		const tabs = ["외관", "모델", "상호작용", "컨텍스트", "메모리", "편집"].map(label => ({ id: label, label }));
		for (let width = 4; width <= 40; width++) {
			for (const line of new TabBar("설정", tabs, ansiTheme).render(width)) {
				expect(Bun.stripANSI(line).trim()).not.toBe("");
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps the active tab marked in one row and reaches tabs outside the visible strip", () => {
		const tabs = ["외관", "모델", "상호작용", "컨텍스트", "메모리", "편집"].map(label => ({ id: label, label }));
		const tabBar = new TabBar("설정", tabs, { ...ansiTheme, compact: true, activeTab: text => `[${text.trim()}]` });
		for (const tab of tabs) {
			const lines = tabBar.render(29);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(29);
			expect(Bun.stripANSI(lines[0])).toContain(`[${tab.label}]`);
			expect(lines[0]).toContain("...");
			expect(tabBar.handleInput("\t")).toBe(true);
		}
		expect(tabBar.getActiveTab()).toEqual(tabs[0]);
		expect(tabBar.handleInput("\x1b[Z")).toBe(true);
		expect(tabBar.getActiveTab()).toEqual(tabs[tabs.length - 1]!);
		expect(Bun.stripANSI(tabBar.render(110)[0])).not.toContain("...");
	});
});
