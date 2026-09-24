/**
 * Prompt routing for the Codex host: the same three stages the session runs in
 * `AgentSession#routeWorkflowSemantically`, rebuilt for a process that lives for
 * one prompt.
 *
 * The session holds settings, credentials and a model registry for its whole
 * life, so its model stage is a few lines. The hook is spawned fresh on every
 * `UserPromptSubmit`, already costs ~260ms to start, and answers most prompts
 * from the keyword tables alone — so everything the model stage needs is loaded
 * lazily, and only on a prompt that actually reaches it. Concretely:
 *
 * - `decisions.enabled` / `decisions.keywordLearning` are read from the same raw
 *   `config.yml` files the hook already parses for skill discovery. Loading
 *   `Settings` for two booleans costs ~200ms of module graph on every prompt.
 * - Learned keywords are one small JSON read, so they are always consulted: a
 *   pattern promoted in a CLI session must fire under Codex too.
 * - Credentials, the registry and the decision service are opened only when the
 *   keyword tables did not fully answer, then closed before the hook exits.
 *
 * Every failure resolves to "no activation", which is what the hook did before
 * this stage existed.
 */
import { getAgentDir } from "@sayknow-cli/utils";
import { YAML } from "bun";
import { loadLearnedKeywordDefinitions, observeRouting } from "../decisions/keyword-learning";
import type { PromptTriage, PromptTriageRequest, PromptTriager } from "../decisions/prompt-triage";
import type { SkillKeywordDefinition } from "./skill-keywords";
import { recordSkillActivation, type SkillActiveState } from "./skill-state";
import { buildUiSkillDirectiveForSkill, detectUiSkillKeywords } from "./ui-skill-keywords";

export interface NativePromptRoutingInput {
	cwd: string;
	text: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	stateDir?: string;
	/** `config.yml` files in precedence order, lowest first; resolved by the hook. */
	configPaths: readonly string[];
	agentDir?: string;
	/** Injected in tests so routing is exercised without credentials or a network. */
	triager?: PromptTriager;
}

export interface NativePromptRoutingResult {
	skillState: SkillActiveState | null;
	/** Directive for a UI skill the model picked because the pattern table missed. */
	uiSkillContext: string | null;
}

interface DecisionSettings {
	enabled: boolean;
	keywordLearning: boolean;
}

/**
 * The two decision switches, read the way the hook reads `skills.*`: raw YAML,
 * later files override earlier ones, absent means the schema default (`true`).
 */
async function readDecisionSettings(configPaths: readonly string[]): Promise<DecisionSettings> {
	const settings: DecisionSettings = { enabled: true, keywordLearning: true };
	for (const configPath of configPaths) {
		let raw: unknown;
		try {
			raw = YAML.parse(await Bun.file(configPath).text());
		} catch {
			continue;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const decisions = (raw as Record<string, unknown>).decisions;
		if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) continue;
		const { enabled, keywordLearning } = decisions as Record<string, unknown>;
		if (typeof enabled === "boolean") settings.enabled = enabled;
		if (typeof keywordLearning === "boolean") settings.keywordLearning = keywordLearning;
	}
	return settings;
}

/**
 * Open credentials and the registry, build the triager, and hand back the
 * teardown. Imported lazily: this graph is what the fast path must never pay for.
 */
async function openTriager(input: NativePromptRoutingInput): Promise<{ triager: PromptTriager; close: () => void }> {
	const [{ Settings }, { ModelRegistry }, { discoverAuthStorage }, { createDecisionService }, { createPromptTriage }] =
		await Promise.all([
			import("../config/settings"),
			import("../config/model-registry"),
			import("../session/auth-storage-discovery"),
			import("../decisions"),
			import("../decisions/prompt-triage"),
		]);
	const agentDir = input.agentDir ?? getAgentDir();
	const settings = await Settings.loadForScope({ cwd: input.cwd, agentDir });
	const authStorage = await discoverAuthStorage(agentDir);
	try {
		const registry = new ModelRegistry(authStorage);
		registry.applyConfiguredModelBindings(settings);
		// Offline: built-in providers are static, and a local runtime's model list
		// comes from the 24h discovery cache the CLI maintains. A network refresh here
		// would put an unbounded fetch in front of every Codex prompt.
		await registry.refresh("offline");
		const service = createDecisionService({
			registry,
			settings,
			sessionId: input.sessionId,
			// This hook only runs under the Codex host, so the provider the user is
			// already talking to is Codex; its small model ranks first when the user
			// has that credential, and the hint is inert when they do not.
			preferredProvider: "openai-codex",
			enabled: true,
		});
		return { triager: createPromptTriage(service), close: () => authStorage.close() };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

export async function routeNativePrompt(input: NativePromptRoutingInput): Promise<NativePromptRoutingResult> {
	const decisions = await readDecisionSettings(input.configPaths);
	const learned = await loadLearned(decisions.keywordLearning);
	const uiMatched = detectUiSkillKeywords(input.text).length > 0;

	let opened: { triager: PromptTriager; close: () => void } | undefined;
	const triage = async (request: Omit<PromptTriageRequest, "text">): Promise<PromptTriage | null> => {
		if (input.triager) return await input.triager({ text: input.text, ...request });
		opened ??= await openTriager(input);
		return await opened.triager({ text: input.text, ...request });
	};

	// Written from inside the semantic callback; a plain `let` would be narrowed
	// to its initialiser by control-flow analysis and read as never-assigned here.
	const seen: { semanticConsulted: boolean; result: PromptTriage | null } = { semanticConsulted: false, result: null };
	try {
		const skillState = await recordSkillActivation({
			cwd: input.cwd,
			text: input.text,
			sessionId: input.sessionId,
			threadId: input.threadId,
			turnId: input.turnId,
			stateDir: input.stateDir,
			learned,
			// Consulted only when no keyword matched — the same turn the session
			// would spend a model call on, asking both questions at once.
			resolveSkillSemantically: decisions.enabled
				? async () => {
						seen.semanticConsulted = true;
						const result = await triage({ skipUiSkill: uiMatched });
						seen.result = result;
						// A null result is "no information" and teaches nothing; a result
						// with a null workflow is the model saying "none", which is a
						// negative example the learner needs.
						if (decisions.keywordLearning && result) {
							await observeRouting({
								text: input.text,
								skill: result.workflow,
								confidence: result.workflowConfidence,
								calibrated: result.calibrated,
							});
						}
						return result?.workflow ?? null;
					}
				: undefined,
		});
		// A keyword answered the workflow question but the UI pattern table missed:
		// the session still asks the UI question alone, and so does the hook.
		if (decisions.enabled && !seen.semanticConsulted && !uiMatched) {
			try {
				seen.result = await triage({ skipWorkflow: true });
			} catch {
				seen.result = null;
			}
		}
		return {
			skillState,
			uiSkillContext: seen.result?.uiSkill ? buildUiSkillDirectiveForSkill(seen.result.uiSkill) : null,
		};
	} finally {
		opened?.close();
	}
}

async function loadLearned(enabled: boolean): Promise<SkillKeywordDefinition[]> {
	if (!enabled) return [];
	try {
		return await loadLearnedKeywordDefinitions();
	} catch {
		return [];
	}
}
