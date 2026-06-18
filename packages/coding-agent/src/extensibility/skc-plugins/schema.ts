import { SKC_PLUGIN_KIND, SkcPluginLoadError, type SkcPluginManifest, type SubskillFrontmatter } from "./types";

const FORBIDDEN_MANIFEST_KEYS = ["skills", "slash-commands", "commands", "hooks", "mcp", "mcpServers", "agents"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new SkcPluginLoadError(
			"invalid_frontmatter",
			`Invalid sub-skill frontmatter in ${filePath}: ${field} must be a non-empty string`,
		);
	}
	return value;
}

function requireStringArray(value: unknown, field: string, manifestPath: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
		throw new SkcPluginLoadError(
			"invalid_manifest",
			`Invalid SKC plugin manifest at ${manifestPath}: ${field} must be a string array`,
		);
	}
	return [...value];
}

export function parseManifest(raw: unknown, manifestPath: string): SkcPluginManifest {
	if (!isRecord(raw)) {
		throw new SkcPluginLoadError(
			"invalid_manifest",
			`Invalid SKC plugin manifest at ${manifestPath}: expected object`,
		);
	}

	for (const key of FORBIDDEN_MANIFEST_KEYS) {
		if (Object.hasOwn(raw, key)) {
			throw new SkcPluginLoadError("forbidden_surface", `Forbidden SKC plugin surface in ${manifestPath}: ${key}`);
		}
	}

	if (raw.kind !== SKC_PLUGIN_KIND) {
		throw new SkcPluginLoadError(
			"invalid_kind",
			`Invalid SKC plugin kind in ${manifestPath}: expected ${SKC_PLUGIN_KIND}`,
		);
	}
	if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
		throw new SkcPluginLoadError(
			"invalid_manifest",
			`Invalid SKC plugin manifest at ${manifestPath}: name must be a non-empty string`,
		);
	}
	if (typeof raw.version !== "string" || raw.version.trim().length === 0) {
		throw new SkcPluginLoadError(
			"invalid_manifest",
			`Invalid SKC plugin manifest at ${manifestPath}: version must be a non-empty string`,
		);
	}

	return {
		name: raw.name,
		version: raw.version,
		kind: SKC_PLUGIN_KIND,
		subskills: requireStringArray(raw.subskills, "subskills", manifestPath),
		tools: requireStringArray(raw.tools, "tools", manifestPath),
	};
}

export function parseSubskillFrontmatter(fm: Record<string, unknown>, filePath: string): SubskillFrontmatter {
	return {
		name: requireNonEmptyString(fm.name, "name", filePath),
		binds_to: requireNonEmptyString(fm.binds_to, "binds_to", filePath),
		phase: requireNonEmptyString(fm.phase, "phase", filePath),
		activation_arg: requireNonEmptyString(fm.activation_arg, "activation_arg", filePath),
		description: requireNonEmptyString(fm.description, "description", filePath),
	};
}
