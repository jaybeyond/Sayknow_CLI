#!/usr/bin/env bun

import * as path from "node:path";

interface GateResult {
	name: string;
	passed: boolean;
	details: string[];
}

const repoRoot = path.join(import.meta.dir, "..");

const results: GateResult[] = [
	await verifyThemeDefaults(),
	await verifyStatusDefaults(),
	await verifyExportBranding(),
	await verifyDocsBranding(),
];

for (const result of results) {
	console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
	for (const detail of result.details) console.log(`  - ${detail}`);
}

const failed = results.filter(result => !result.passed);
if (failed.length > 0) {
	console.error(`\nSKC UI redesign verification failed: ${failed.map(result => result.name).join(", ")}`);
	process.exit(1);
}

console.log("\nSKC UI redesign verification passed.");

async function verifyThemeDefaults(): Promise<GateResult> {
	const settings = await readText("packages/coding-agent/src/config/settings-schema.ts");
	const themeRuntime = await readText("packages/coding-agent/src/modes/theme/theme.ts");
	const redOctopus = await readJson("packages/coding-agent/src/modes/theme/defaults/red-octopus.json");
	const blueOctopus = await readJson("packages/coding-agent/src/modes/theme/defaults/blue-octopus.json");
	const defaultIndex = await readText("packages/coding-agent/src/modes/theme/defaults/index.ts");
	const colors = isRecord(redOctopus.colors) ? redOctopus.colors : {};
	const vars = isRecord(redOctopus.vars) ? redOctopus.vars : {};

	const semanticPairs = [
		["accent", "error"],
		["accent", "warning"],
		["accent", "toolDiffRemoved"],
		["error", "warning"],
		["error", "toolDiffRemoved"],
	] as const;
	const semanticFindings = semanticPairs
		.filter(([left, right]) => resolveColor(colors[left], vars) === resolveColor(colors[right], vars))
		.map(([left, right]) => `${left} matches ${right}`);

	const expectedBuiltIns = ["blue-octopus", "claude-code", "codex", "gruvbox-dark", "opencode", "red-octopus"];
	const retainedBuiltIns =
		[...defaultIndex.matchAll(/^import /gm)].length === expectedBuiltIns.length &&
		[...defaultIndex.matchAll(/^\t/gm)].length === expectedBuiltIns.length &&
		defaultIndex.includes('"blue-octopus": blue_octopus') &&
		defaultIndex.includes('"claude-code": claude_code') &&
		defaultIndex.includes("\tcodex,") &&
		defaultIndex.includes('"gruvbox-dark": gruvbox_dark') &&
		defaultIndex.includes("\topencode,") &&
		defaultIndex.includes('"red-octopus": red_octopus') &&
		!defaultIndex.includes("light_") &&
		!defaultIndex.includes("light_") &&
		isRecord(blueOctopus.colors);

	return {
		name: "blue-octopus default (dark + light) with red-octopus alternate, semantic token split",
		passed:
			settings.includes('default: "blue-octopus"') &&
			themeRuntime.includes('autoDarkTheme: string = "blue-octopus"') &&
			themeRuntime.includes('autoLightTheme: string = "blue-octopus"') &&
			retainedBuiltIns &&
			resolveColor(colors.accent, vars) === resolveColor(vars.tentacle, vars) &&
			resolveColor(colors.error, vars) === resolveColor(vars.dangerRed, vars) &&
			resolveColor(colors.warning, vars) === resolveColor(vars.warningAmber, vars) &&
			resolveColor(colors.toolDiffRemoved, vars) === resolveColor(vars.diffRemovalRed, vars) &&
			semanticFindings.length === 0,
		details: [
			`settings default blue-octopus: ${settings.includes('default: "blue-octopus"')}`,
			`runtime autoDarkTheme blue-octopus: ${themeRuntime.includes('autoDarkTheme: string = "blue-octopus"')}`,
			`runtime autoLightTheme blue-octopus: ${themeRuntime.includes('autoLightTheme: string = "blue-octopus"')}`,
			`expected built-in themes (${expectedBuiltIns.join(", ")}): ${retainedBuiltIns}`,
			`semantic collisions: ${semanticFindings.join("; ") || "<none>"}`,
		],
	};
}

async function verifyStatusDefaults(): Promise<GateResult> {
	const presets = await readText("packages/coding-agent/src/modes/components/status-line/presets.ts");
	const defaultStart = presets.indexOf("default:");
	const minimalStart = presets.indexOf("minimal:");
	const compactStart = presets.indexOf("compact:");
	const fullStart = presets.indexOf("full:");
	const defaultBlock = defaultStart >= 0 && minimalStart > defaultStart ? presets.slice(defaultStart, minimalStart) : "";
	const compactBlock = compactStart >= 0 && fullStart > compactStart ? presets.slice(compactStart, fullStart) : "";
	const leftSegmentsByPreset = parsePresetLeftSegments(presets);
	const publicPresetUsesPi = Object.entries(leftSegmentsByPreset).filter(([, segments]) => segments.includes("pi"));
	const fullUsesSayknow = leftSegmentsByPreset.full?.includes("sayknow") === true;
	const nerdUsesSayknow = leftSegmentsByPreset.nerd?.includes("sayknow") === true;
	return {
		name: "default-visible status line identity",
		passed:
			defaultBlock.includes('separator: "slash"') &&
			!defaultBlock.includes('"pi"') &&
			compactBlock.includes('separator: "slash"') &&
			presets.includes('full: {') &&
			fullUsesSayknow &&
			nerdUsesSayknow &&
			publicPresetUsesPi.length === 0,
		details: [
			`default separator slash: ${defaultBlock.includes('separator: "slash"')}`,
			`default pi segment absent: ${!defaultBlock.includes('"pi"')}`,
			`full SKC identity present: ${fullUsesSayknow}`,
			`nerd SKC identity present: ${nerdUsesSayknow}`,
			`public pi preset absent: ${publicPresetUsesPi.length === 0}${
				publicPresetUsesPi.length > 0 ? ` (${publicPresetUsesPi.map(([name]) => name).join(", ")})` : ""
			}`,
		],
	};
}

function parsePresetLeftSegments(source: string): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	const presetRegex = /\n\t([a-z_]+): \{[\s\S]*?leftSegments: \[([^\]]*)\]/g;
	for (const match of source.matchAll(presetRegex)) {
		const [, name, rawSegments] = match;
		if (!name || !rawSegments) continue;
		result[name] = [...rawSegments.matchAll(/"([^"]+)"/g)].map(segmentMatch => segmentMatch[1]).filter(Boolean);
	}
	return result;
}

async function verifyExportBranding(): Promise<GateResult> {
	const templateHtml = await readText("packages/coding-agent/src/export/html/template.html");
	const templateJs = await readText("packages/coding-agent/src/export/html/template.js");
	const generated = await readText("packages/coding-agent/src/export/html/template.generated.ts");
	return {
		name: "HTML export SKC branding",
		passed:
			templateHtml.includes("SKC Session Export") &&
			templateHtml.includes('content="sayknow-cli"') &&
			templateJs.includes("sayknow-cli · red-octopus transcript") &&
			templateJs.includes("SKC / sayknow-cli") &&
			templateJs.includes('meta[name="skc-url-params"]') &&
			templateJs.includes('meta[name="skc-share-base-url"]') &&
			templateJs.includes("skc-share:v1:sidebar-width") &&
			templateJs.includes('meta[name="pi-url-params"]') &&
			templateJs.includes('meta[name="pi-share-base-url"]') &&
			templateJs.includes("pi-share:v1:sidebar-width") &&
			generated.includes("SKC Session Export") &&
			generated.includes("tool-output"),
		details: [
			`title/meta branded: ${templateHtml.includes("SKC Session Export") && templateHtml.includes('content="sayknow-cli"')}`,
			`header product branded: ${templateJs.includes("SKC / sayknow-cli")}`,
			`SKC metadata/storage keys present: ${templateJs.includes('meta[name="skc-url-params"]') && templateJs.includes('meta[name="skc-share-base-url"]') && templateJs.includes("skc-share:v1:sidebar-width")}`,
			`legacy metadata/storage fallback retained: ${templateJs.includes('meta[name="pi-url-params"]') && templateJs.includes('meta[name="pi-share-base-url"]') && templateJs.includes("pi-share:v1:sidebar-width")}`,
			`generated template refreshed: ${generated.includes("SKC Session Export")}`,
			`transcript tool content still present: ${generated.includes("tool-output")}`,
		],
	};
}

async function verifyDocsBranding(): Promise<GateResult> {
	const rootReadme = await readText("README.md");
	const packageReadme = await readText("packages/coding-agent/README.md");
	const themeDoc = await readText("docs/theme.md");
	return {
		name: "public docs current SKC cephalopod theme direction",
		passed:
			rootReadme.includes("default TUI identity is the SKC **blue-octopus** theme") &&
			rootReadme.includes("for both dark and light terminals") &&
			packageReadme.includes("defaults to the bundled `blue-octopus`") &&
			packageReadme.includes("`red-octopus`") &&
			themeDoc.includes('theme.dark = "blue-octopus"') &&
			themeDoc.includes('theme.light = "blue-octopus"'),
		details: [
			`README blue-octopus default: ${rootReadme.includes("default TUI identity is the SKC **blue-octopus** theme")}`,
			`README both dark and light: ${rootReadme.includes("for both dark and light terminals")}`,
			`package README default blue-octopus: ${packageReadme.includes("defaults to the bundled `blue-octopus`")}`,
			`package README red-octopus alternate: ${packageReadme.includes("`red-octopus`")}`,
			`theme docs default dark blue-octopus: ${themeDoc.includes('theme.dark = "blue-octopus"')}`,
			`theme docs default light blue-octopus: ${themeDoc.includes('theme.light = "blue-octopus"')}`,
		],
	};
}

async function readText(relativePath: string): Promise<string> {
	return await Bun.file(path.join(repoRoot, relativePath)).text();
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
	const value = await Bun.file(path.join(repoRoot, relativePath)).json();
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveColor(value: unknown, vars: Record<string, unknown>): unknown {
	if (typeof value !== "string") return value;
	const key = value.startsWith("$") ? value.slice(1) : value;
	return key in vars ? vars[key] : value;
}
