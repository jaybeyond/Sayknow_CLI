import { logger } from "@sayknow-cli/utils";
import { loadSkcPlugins } from "./loader";
import { discoverSkcPluginRoots } from "./paths";
import { type LoadedSkcPlugin, type LoadedSubskillActivation, SkcPluginLoadError } from "./types";

export interface SubskillActivationResult {
	cleanedArgs: string;
	activation?: LoadedSubskillActivation;
	activeSubskillsToPersist: LoadedSubskillActivation[];
}

export async function resolveSubskillActivationForSkillInvocation(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	skillName: string;
	args: string;
}): Promise<SubskillActivationResult> {
	const roots = await discoverSkcPluginRoots({ cwd: input.cwd });
	let plugins: LoadedSkcPlugin[];
	try {
		plugins = await loadSkcPlugins(roots);
	} catch (error) {
		if (error instanceof SkcPluginLoadError) throw error;
		logger.warn("Skipping SKC plugin activation set after load error", {
			error: error instanceof Error ? error.message : String(error),
		});
		plugins = [];
	}

	const bindings = plugins.flatMap(plugin => plugin.bindings);
	const activationsByArg = new Map<string, LoadedSubskillActivation>();
	for (const binding of bindings) {
		if (binding.parent !== input.skillName) continue;
		activationsByArg.set(binding.activationArg, {
			activationArg: binding.activationArg,
			plugin: binding.plugin,
			subskillName: binding.subskillName,
			parent: binding.parent,
			bindsTo: binding.bindsTo,
			phase: binding.phase,
			filePath: binding.filePath,
			toolPaths: binding.toolPaths,
		});
	}

	const tokens = input.args
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
	let activation: LoadedSubskillActivation | undefined;
	const cleanedTokens: string[] = [];
	let consumed = false;
	for (const token of tokens) {
		if (!consumed && token.startsWith("--") && !token.includes("=")) {
			const candidate = activationsByArg.get(token.slice(2));
			if (candidate) {
				activation = candidate;
				consumed = true;
				continue;
			}
		}
		cleanedTokens.push(token);
	}

	return {
		cleanedArgs: consumed ? cleanedTokens.join(" ") : input.args,
		activation,
		activeSubskillsToPersist: activation
			? bindings
					.filter(
						binding => binding.plugin === activation.plugin && binding.activationArg === activation.activationArg,
					)
					.map(binding => ({
						activationArg: binding.activationArg,
						plugin: binding.plugin,
						subskillName: binding.subskillName,
						parent: binding.parent,
						bindsTo: binding.bindsTo,
						phase: binding.phase,
						filePath: binding.filePath,
						toolPaths: binding.toolPaths,
					}))
			: [],
	};
}
