import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { SettingPath } from "@sayknow-cli/coding-agent/config/settings";
import { resetSettingsForTest, Settings, settings } from "@sayknow-cli/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@sayknow-cli/coding-agent/modes/components/settings-selector";
import { initTheme } from "@sayknow-cli/coding-agent/modes/theme/theme";

const THEMES = ["red-octopus", "blue-octopus"];

type ChangedSetting = {
	path: SettingPath;
	value: unknown;
};

type SelectorHarness = {
	component: SettingsSelectorComponent;
	previewedThemes: string[];
	restoredThemes: string[];
	changedSettings: ChangedSetting[];
};

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-octopus", "blue-octopus");
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	settings.set("theme.dark", "red-octopus");
	settings.set("theme.light", "blue-octopus");
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function createSelector(): SelectorHarness {
	const previewedThemes: string[] = [];
	const restoredThemes: string[] = [];
	const changedSettings: ChangedSetting[] = [];
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: THEMES,
			availableModelProfiles: [],
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => {
				changedSettings.push({ path, value });
			},
			onThemePreview: themeName => {
				previewedThemes.push(themeName);
			},
			onThemePreviewCancel: themeName => {
				restoredThemes.push(themeName);
			},
			onCancel: () => {},
			getStatusLinePreview: () => "status-preview",
		},
	);
	return { component, previewedThemes, restoredThemes, changedSettings };
}

describe("SettingsSelectorComponent theme selection", () => {
	it("previews a dark theme while browsing without persisting it", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-octopus is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-octopus.

		expect(previewedThemes).toEqual(["blue-octopus"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("red-octopus");
	});

	it("restores the pre-preview rendered theme on cancel and leaves dark settings unchanged", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu; red-octopus is preselected.
		component.handleInput("\x1b[B"); // Browse to blue-octopus.
		component.handleInput("\x1b"); // Cancel submenu.

		expect(previewedThemes).toEqual(["blue-octopus"]);
		expect(restoredThemes).toEqual(["red-octopus"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.dark")).toBe("red-octopus");
		expect(component.render(120).join("\n")).toContain("red-octopus");
	});

	it("persists and displays the selected dark theme only after confirmation", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\n"); // Open Dark Theme submenu.
		component.handleInput("\x1b[B"); // Browse to blue-octopus.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["blue-octopus"]);
		expect(restoredThemes).toEqual([]);
		expect(changedSettings).toEqual([{ path: "theme.dark", value: "blue-octopus" }]);
		expect(settings.get("theme.dark")).toBe("blue-octopus");
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("blue-octopus");
	});

	it("keeps light theme preview independent from persisted light settings", () => {
		const { component, previewedThemes, restoredThemes, changedSettings } = createSelector();

		component.handleInput("\x1b[B"); // Move from Dark Theme to Light Theme.
		component.handleInput("\n"); // Open Light Theme submenu; blue-octopus is preselected.
		component.handleInput("\x1b[B"); // Wrap to red-octopus.
		component.handleInput("\x1b"); // Cancel.

		expect(previewedThemes).toEqual(["red-octopus"]);
		expect(restoredThemes).toEqual(["red-octopus"]);
		expect(changedSettings).toEqual([]);
		expect(settings.get("theme.light")).toBe("blue-octopus");

		component.handleInput("\n"); // Reopen Light Theme submenu.
		component.handleInput("\x1b[B"); // Wrap to red-octopus.
		component.handleInput("\n"); // Confirm.

		expect(previewedThemes).toEqual(["red-octopus", "red-octopus"]);
		expect(restoredThemes).toEqual(["red-octopus"]);
		expect(changedSettings).toEqual([{ path: "theme.light", value: "red-octopus" }]);
		expect(settings.get("theme.light")).toBe("red-octopus");
	});
});
