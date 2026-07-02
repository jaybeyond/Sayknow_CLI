import { isKnownWorkflowState } from "../../skc-runtime/workflow-manifest";
import type { CanonicalSkcWorkflowSkill } from "../../skill-state/active-state";
import { assertMcpInstallPolicy } from "./mcp-policy";
import {
	type LoadedSubskillBinding,
	type NormalizedSkcPluginBundle,
	SKC_AGENT_SUBSKILL_PHASES,
	SKC_SUBSKILL_PARENT_AGENTS,
	SKC_SUBSKILL_PARENT_SKILLS,
	SkcPluginLoadError,
	type SkcPluginRegistryEntry,
	type SkcSubskillParentAgent,
	type SubskillFrontmatter,
} from "./types";

function isParentSkill(value: string): value is CanonicalSkcWorkflowSkill {
	return (SKC_SUBSKILL_PARENT_SKILLS as readonly string[]).includes(value);
}

function isParentAgent(value: string): value is SkcSubskillParentAgent {
	return (SKC_SUBSKILL_PARENT_AGENTS as readonly string[]).includes(value);
}

export function validateBinding(fm: SubskillFrontmatter): void {
	const parent = fm.binds_to;
	if (isParentSkill(parent)) {
		if (!isKnownWorkflowState(parent, fm.phase)) {
			throw new SkcPluginLoadError("invalid_phase", `Invalid SKC sub-skill phase for ${parent}: ${fm.phase}`);
		}
		return;
	}

	if (isParentAgent(parent)) {
		if (!SKC_AGENT_SUBSKILL_PHASES[parent].includes(fm.phase)) {
			throw new SkcPluginLoadError("invalid_phase", `Invalid SKC sub-skill phase for ${parent}: ${fm.phase}`);
		}
		return;
	}

	throw new SkcPluginLoadError("invalid_parent", `Invalid SKC sub-skill parent: ${parent}`);
}

export function buildParentArgMap(
	bindings: readonly LoadedSubskillBinding[],
): Map<string, Map<string, LoadedSubskillBinding>> {
	const byParent = new Map<string, Map<string, LoadedSubskillBinding>>();
	for (const binding of bindings) {
		let byArg = byParent.get(binding.parent);
		if (!byArg) {
			byArg = new Map<string, LoadedSubskillBinding>();
			byParent.set(binding.parent, byArg);
		}
		const existing = byArg.get(binding.activationArg);
		if (existing) {
			throw new SkcPluginLoadError(
				"duplicate_arg",
				`Duplicate SKC sub-skill activation_arg for ${binding.parent}: ${binding.activationArg} (${existing.filePath}, ${binding.filePath})`,
			);
		}
		byArg.set(binding.activationArg, binding);
	}
	return byParent;
}

export function buildParentPhaseSet(bindings: readonly LoadedSubskillBinding[]): Set<string> {
	const seen = new Map<string, LoadedSubskillBinding>();
	for (const binding of bindings) {
		const key = `${binding.parent}\u0000${binding.phase}`;
		const existing = seen.get(key);
		if (existing) {
			throw new SkcPluginLoadError(
				"duplicate_parent_phase",
				`Duplicate SKC sub-skill parent/phase binding for ${binding.parent}/${binding.phase} (${existing.filePath}, ${binding.filePath})`,
			);
		}
		seen.set(key, binding);
	}
	return new Set(seen.keys());
}

/**
 * Hard install-time collision + security validation for a compiled bundle
 * against the effective installed registry (other plugins in the target scope
 * universe). Collisions are hard errors; the registry is the collision
 * authority, never capability first-wins.
 */
export function validateInstallPlan(
	bundle: NormalizedSkcPluginBundle,
	effectiveEntries: readonly SkcPluginRegistryEntry[],
): void {
	const others = effectiveEntries.filter(e => e.name !== bundle.name);

	const toolNames = new Set<string>();
	const hookKeys = new Set<string>();
	const mcpNames = new Set<string>();
	const appendixIds = new Set<string>();
	const subskillArgs = new Set<string>();
	const parentPhases = new Set<string>();
	for (const e of others) {
		for (const t of e.surfaces.tools) toolNames.add(t.name);
		for (const h of e.surfaces.hooks) hookKeys.add(h.extensionId);
		for (const m of e.surfaces.mcps) mcpNames.add(m.name);
		for (const a of e.surfaces.systemAppendices) appendixIds.add(a.extensionId);
		for (const a of e.surfaces.agentAppendices) appendixIds.add(a.extensionId);
		for (const s of e.surfaces.subskills) {
			subskillArgs.add(`${s.parent}\u0000${s.activationArg}`);
			parentPhases.add(`${s.parent}\u0000${s.phase}`);
		}
	}

	// Check candidate surfaces against the effective registry AND against each
	// other (intra-bundle duplicates are also hard errors).
	for (const t of bundle.surfaces.tools) {
		if (toolNames.has(t.name)) {
			throw new SkcPluginLoadError("duplicate_tool", `SKC plugin tool name collides: ${t.name}`);
		}
		toolNames.add(t.name);
	}
	for (const h of bundle.surfaces.hooks) {
		if (hookKeys.has(h.extensionId)) {
			throw new SkcPluginLoadError("duplicate_hook", `SKC plugin hook collides: ${h.extensionId}`);
		}
		hookKeys.add(h.extensionId);
	}
	for (const m of bundle.surfaces.mcps) {
		if (mcpNames.has(m.name)) {
			throw new SkcPluginLoadError("duplicate_mcp", `SKC plugin MCP name collides: ${m.name}`);
		}
		mcpNames.add(m.name);
		assertMcpInstallPolicy(m.config, { pluginRoot: bundle.root });
	}
	for (const a of [...bundle.surfaces.systemAppendices, ...bundle.surfaces.agentAppendices]) {
		if (appendixIds.has(a.extensionId)) {
			throw new SkcPluginLoadError("duplicate_appendix", `SKC plugin appendix collides: ${a.extensionId}`);
		}
		appendixIds.add(a.extensionId);
	}
	for (const s of bundle.surfaces.subskills) {
		const argKey = `${s.parent}\u0000${s.activationArg}`;
		const phaseKey = `${s.parent}\u0000${s.phase}`;
		if (subskillArgs.has(argKey)) {
			throw new SkcPluginLoadError(
				"duplicate_arg",
				`SKC plugin subskill activation_arg collides for ${s.parent}: ${s.activationArg}`,
			);
		}
		if (parentPhases.has(phaseKey)) {
			throw new SkcPluginLoadError(
				"duplicate_parent_phase",
				`SKC plugin subskill parent/phase collides: ${s.parent}/${s.phase}`,
			);
		}
		subskillArgs.add(argKey);
		parentPhases.add(phaseKey);
	}
}
