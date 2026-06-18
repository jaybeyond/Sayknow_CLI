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

export interface SkcPluginManifest {
	name: string;
	version: string;
	kind: "sayknow-cli-plugin";
	subskills: string[];
	tools: string[];
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
	| "forbidden_surface"
	| "invalid_manifest"
	| "invalid_frontmatter"
	| "invalid_parent"
	| "invalid_phase"
	| "duplicate_arg"
	| "duplicate_parent_phase"
	| "missing_file"
	| "invalid_kind";

export class SkcPluginLoadError extends Error {
	readonly code: SkcPluginLoadErrorCode;

	constructor(code: SkcPluginLoadErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SkcPluginLoadError";
		this.code = code;
	}
}
