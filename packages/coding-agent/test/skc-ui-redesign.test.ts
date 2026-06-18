import { afterEach, describe, expect, it, vi } from "bun:test";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import { TEMPLATE } from "../src/export/html/template.generated";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { defaultThemes } from "../src/modes/theme/defaults";
import blueOctopusTheme from "../src/modes/theme/defaults/blue-octopus.json" with { type: "json" };
import redOctopusTheme from "../src/modes/theme/defaults/red-octopus.json" with { type: "json" };
import * as themeModule from "../src/modes/theme/theme";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("SKC red-octopus redesign defaults", () => {
	afterEach(() => {
		themeModule.stopThemeWatcher();
		vi.restoreAllMocks();
	});

	it("uses blue-octopus as the default dark and light theme", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false);

		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("blue-octopus");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-octopus");
		expect(themeModule.getCurrentThemeName()).toBe("blue-octopus");

		themeModule.onTerminalAppearanceChange("light");
		await themeModule.initTheme(false);
		expect(themeModule.getCurrentThemeName()).toBe("blue-octopus");
	});

	it("keeps red-octopus brand tokens separate from semantic warning/error/diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("red-octopus");
		const vars = redOctopusTheme.vars;

		expect(vars.brandRed).toBeDefined();
		expect(vars.tentacle).toBeDefined();
		expect(vars.coral).toBeDefined();
		expect(vars.shell).toBeDefined();
		expect(vars.dangerRed).toBeDefined();
		expect(vars.warningAmber).toBeDefined();
		expect(vars.diffRemovalRed).toBeDefined();

		expect(colors.accent).toBe(vars.tentacle);
		expect(colors.borderAccent).toBe(vars.brandRed);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
	});

	it("exposes bundled selectable themes while preserving red-octopus and blue-octopus defaults", async () => {
		const themes = await themeModule.getAvailableThemes();

		expect(themes).toEqual(["blue-octopus", "claude-code", "codex", "opencode", "red-octopus"]);
		expect(Object.keys(defaultThemes).sort()).toEqual([
			"blue-octopus",
			"claude-code",
			"codex",
			"opencode",
			"red-octopus",
		]);
		expect(SETTINGS_SCHEMA["theme.dark"].default).toBe("blue-octopus");
		expect(SETTINGS_SCHEMA["theme.light"].default).toBe("blue-octopus");
	});

	it("validates every bundled built-in theme against the schema-required token set", async () => {
		for (const [key, themeJson] of Object.entries(defaultThemes)) {
			// Registered map key must equal the theme's declared name.
			expect((themeJson as { name: string }).name, key).toBe(key);

			const colorKeys = Object.keys((themeJson as { colors: Record<string, unknown> }).colors);
			for (const token of themeModule.THEME_COLOR_KEYS) {
				expect(colorKeys, `${key} missing required token ${token}`).toContain(token);
			}

			// Var references resolve without missing/circular errors.
			const resolved = await themeModule.getResolvedThemeColors(key);
			expect(Object.keys(resolved).length, key).toBeGreaterThan(0);
		}
	});

	it("keeps migration themes dark-classified with distinct semantic tokens and no dead link token", async () => {
		for (const name of ["claude-code", "codex", "opencode"] as const) {
			const themeJson = defaultThemes[name] as {
				colors: Record<string, unknown>;
				symbols?: { overrides?: Record<string, unknown> };
			};
			// Do not carry the legacy non-schema `link` token into migration themes.
			expect(Object.keys(themeJson.colors), `${name} has dead link token`).not.toContain("link");

			// Migration themes keep SKC's symbol identity: preset only, no crab/source-tool overrides.
			expect(themeJson.symbols?.overrides, `${name} must not override SKC symbols`).toBeUndefined();

			expect(themeModule.isLightTheme(name), `${name} should classify as dark`).toBe(false);

			const colors = await themeModule.getResolvedThemeColors(name);
			expect(
				new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size,
				`${name} semantic tokens must be distinct`,
			).toBe(4);
		}
	});

	it("uses concrete hex for codex semantic, background, status, and diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("codex");
		const hex = /^#[0-9a-fA-F]{6}$/;
		for (const token of [
			"accent",
			"error",
			"warning",
			"toolDiffRemoved",
			"toolDiffAdded",
			"userMessageBg",
			"selectedBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
			"statusLineBg",
		]) {
			expect(colors[token], `codex ${token} must be concrete hex`).toMatch(hex);
		}
	});

	it("keeps blue-octopus coastal tokens separate from semantic warning/error/diff tokens", async () => {
		const colors = await themeModule.getResolvedThemeColors("blue-octopus");
		const vars = blueOctopusTheme.vars;

		expect(vars.brandBlue).toBeDefined();
		expect(vars.tentacle).toBeDefined();
		expect(vars.seafoam).toBeDefined();
		expect(vars.sand).toBeDefined();
		expect(vars.dangerRed).toBeDefined();
		expect(vars.warningAmber).toBeDefined();
		expect(vars.diffRemovalRed).toBeDefined();

		expect(colors.accent).toBe(vars.tentacle);
		expect(colors.borderAccent).toBe(vars.brandBlue);
		expect(colors.error).toBe(vars.dangerRed);
		expect(colors.warning).toBe(vars.warningAmber);
		expect(colors.toolDiffRemoved).toBe(vars.diffRemovalRed);
		expect(new Set([colors.accent, colors.error, colors.warning, colors.toolDiffRemoved]).size).toBe(4);
	});

	it("exposes /theme only for TUI selection, not ACP text clients", () => {
		const command = lookupBuiltinSlashCommand("theme");

		expect(command?.handleTui).toBeDefined();
		expect(command?.handle).toBeUndefined();
		expect(ACP_BUILTIN_SLASH_COMMANDS.map(item => item.name)).not.toContain("theme");
	});

	it("keeps public status presets on the SKC identity", () => {
		expect(SETTINGS_SCHEMA["statusLine.separator"].default).toBe("slash");
		expect(STATUS_LINE_PRESETS.default.leftSegments).not.toContain("pi");
		expect(STATUS_LINE_PRESETS.default.separator).toBe("slash");
		expect(STATUS_LINE_PRESETS.full.leftSegments).toContain("sayknow");
		expect(STATUS_LINE_PRESETS.nerd.leftSegments).toContain("sayknow");
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments, name).not.toContain("pi");
		}
	});

	it("brands HTML session exports as SKC without changing transcript role support", () => {
		expect(TEMPLATE).toContain("<title>SKC Session Export</title>");
		expect(TEMPLATE).toContain('content="sayknow-cli"');
		expect(TEMPLATE).toContain("SKC Session Export:");
		expect(TEMPLATE).toContain("SKC / sayknow-cli");
		expect(TEMPLATE).toContain('meta[name="skc-url-params"]');
		expect(TEMPLATE).toContain('meta[name="skc-share-base-url"]');
		expect(TEMPLATE).toContain("skc-share:v1:sidebar-width");
		expect(TEMPLATE).toContain('meta[name="pi-url-params"]');
		expect(TEMPLATE).toContain('meta[name="pi-share-base-url"]');
		expect(TEMPLATE).toContain("pi-share:v1:sidebar-width");
		expect(TEMPLATE).toContain("developer-message");
		expect(TEMPLATE).toContain("tool-output");
	});
});
