import type { CanonicalSkcWorkflowSkill } from "../../skill-state/active-state";
import { CANONICAL_SKC_WORKFLOW_SKILLS } from "../../skill-state/active-state";

export const SKC_PLUGIN_MANIFEST_FILENAME = "sayknow-plugin.json";
export const SKC_PLUGIN_KIND = "sayknow-cli-plugin";

export const SKC_SUBSKILL_PARENT_SKILLS = CANONICAL_SKC_WORKFLOW_SKILLS;
export type SkcSubskillParentSkill = CanonicalSkcWorkflowSkill;

export const SKC_SUBSKILL_PARENT_AGENTS = ["executor", "architect", "planner", "critic"] as const;
export type SkcSubskillParentAgent = (typeof SKC_SUBSKILL_PARENT_AGENTS)[number];

export type SkcSubskillParent = SkcSubskillParentSkill | SkcSubskillParentAgent;

export const SKC_AGENT_SUBSKILL_PHASES: Record<SkcSubskillParentAgent, string[]> = {
	executor: ["prompt"],
	architect: ["prompt"],
	planner: ["prompt"],
	critic: ["prompt"],
};

export interface SkcPluginToolManifestEntry {
	name: string;
	path: string;
	description?: string;
	sha256?: string;
	/**
	 * "always-on" object entries are activated for the whole session; legacy
	 * string shorthand stays "subskill"-scoped and is only attached to subskill
	 * bindings (never registered as an always-on tool surface).
	 */
	surface: "subskill" | "always-on";
}

export interface SkcPluginHookManifestEntry {
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	path: string;
	sha256?: string;
}

export type SkcPluginMcpTransport = "stdio" | "http" | "sse";

export interface SkcPluginMcpManifestEntry {
	name: string;
	transport: SkcPluginMcpTransport;
	command?: string;
	args?: string[];
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	sha256?: string;
}

export interface SkcPluginAppendixManifestEntry {
	name: string;
	path?: string;
	content?: string;
	sha256?: string;
}

export interface SkcPluginAgentAppendixManifestEntry extends SkcPluginAppendixManifestEntry {
	agent: SkcSubskillParentAgent;
}

export interface SkcPluginManifest {
	name: string;
	version: string;
	kind: "sayknow-cli-plugin";
	subskills: string[];
	tools: SkcPluginToolManifestEntry[];
	hooks: SkcPluginHookManifestEntry[];
	mcps: SkcPluginMcpManifestEntry[];
	systemAppendix: SkcPluginAppendixManifestEntry[];
	agentAppendix: SkcPluginAgentAppendixManifestEntry[];
}

export interface SubskillFrontmatter {
	name: string;
	binds_to: string;
	phase: string;
	activation_arg: string;
	description: string;
}

export interface LoadedSubskillBinding {
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	activationArg: string;
	description: string;
	filePath: string;
	body: string;
	toolPaths: string[];
}

export interface LoadedSubskillActivation {
	activationArg: string;
	plugin: string;
	subskillName: string;
	parent: string;
	bindsTo: string;
	phase: string;
	filePath: string;
	toolPaths: string[];
}

export interface PhaseScopedToolBinding {
	plugin: string;
	parent: string;
	phase: string;
	toolPath: string;
}

export interface LoadedSkcPlugin {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	bindings: LoadedSubskillBinding[];
	toolBindings: PhaseScopedToolBinding[];
}

export type SkcPluginLoadErrorCode =
	// Parse-time
	| "forbidden_surface"
	| "invalid_manifest"
	| "invalid_kind"
	| "unsupported_surface"
	// Compile-time
	| "invalid_frontmatter"
	| "invalid_parent"
	| "invalid_phase"
	| "missing_file"
	| "hash_mismatch"
	| "invalid_appendix"
	| "invalid_hook"
	| "invalid_mcp"
	// Install-time
	| "duplicate_arg"
	| "duplicate_parent_phase"
	| "duplicate_tool"
	| "duplicate_hook"
	| "duplicate_mcp"
	| "duplicate_appendix"
	| "security_policy"
	| "install_conflict"
	// Session-start / runtime
	| "session_collision"
	| "runtime_mismatch"
	| "quarantined_surface";

export class SkcPluginLoadError extends Error {
	readonly code: SkcPluginLoadErrorCode;

	constructor(code: SkcPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SkcPluginLoadError";
		this.code = code;
	}
}

export type SkcPluginScope = "user" | "project";

export type SkcPluginSourceKind = "path" | "git" | "tarball";

export interface SkcPluginCopiedFile {
	relativePath: string;
	sha256: string;
	bytes: number;
}

export interface NormalizedSubskillSurface {
	extensionId: string;
	name: string;
	description: string;
	parent: string;
	phase: string;
	activationArg: string;
	relativePath: string;
	sha256: string;
}

export interface NormalizedToolSurface {
	extensionId: string;
	name: string;
	relativePath: string;
	sha256: string;
	description?: string;
}

export interface NormalizedHookSurface {
	extensionId: string;
	name: string;
	event: string;
	target?: string;
	phase?: "before" | "after";
	relativePath: string;
	sha256: string;
}

export interface NormalizedMcpSurface {
	extensionId: string;
	name: string;
	transport: SkcPluginMcpTransport;
	configHash: string;
	config: SkcPluginMcpManifestEntry;
}

export interface NormalizedAppendixSurface {
	extensionId: string;
	name: string;
	relativePath?: string;
	/** Inline appendix body (when the manifest used `content` instead of `path`). */
	content?: string;
	contentHash: string;
	bytes: number;
}

export interface NormalizedAgentAppendixSurface extends NormalizedAppendixSurface {
	agent: SkcSubskillParentAgent;
}

export interface NormalizedSkcPluginSurfaces {
	subskills: NormalizedSubskillSurface[];
	tools: NormalizedToolSurface[];
	hooks: NormalizedHookSurface[];
	mcps: NormalizedMcpSurface[];
	systemAppendices: NormalizedAppendixSurface[];
	agentAppendices: NormalizedAgentAppendixSurface[];
}

/**
 * Result of the pure compile step. Computed from manifest, frontmatter, and
 * declared files read as bytes only — never by importing plugin code.
 */
export interface NormalizedSkcPluginBundle {
	name: string;
	version: string;
	root: string;
	manifestPath: string;
	manifestHash: string;
	surfaces: NormalizedSkcPluginSurfaces;
	files: SkcPluginCopiedFile[];
}

export interface SkcPluginQuarantineEntry {
	surfaceId: string;
	code: SkcPluginLoadErrorCode;
	message: string;
	detectedAt: string;
}

export interface SkcPluginRegistrySource {
	kind: SkcPluginSourceKind;
	uri: string;
	ref?: string;
	sha?: string;
	resolvedAt: string;
}

export interface SkcPluginRegistryEntry {
	name: string;
	version: string;
	scope: SkcPluginScope;
	enabled: boolean;
	pluginRoot: string;
	manifestPath: string;
	manifestHash: string;
	source: SkcPluginRegistrySource;
	installedAt: string;
	updatedAt: string;
	copiedFiles: SkcPluginCopiedFile[];
	surfaces: NormalizedSkcPluginSurfaces;
	disabledSurfaceIds: string[];
	quarantine?: SkcPluginQuarantineEntry[];
}

export interface SkcPluginRegistry {
	version: 1;
	scope: SkcPluginScope;
	plugins: SkcPluginRegistryEntry[];
}

/**
 * Stable identifiers for plugin-contributed surfaces used by observability,
 * disabledSurfaceIds, and quarantine bookkeeping.
 */
export type SkcPluginSurfaceExtensionId = string;
