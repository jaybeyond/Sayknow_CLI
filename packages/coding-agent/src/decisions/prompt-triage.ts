/**
 * One typed decision per user turn, answering every routing question SKC has.
 *
 * Typed decisions started out wired to exactly one question — a five-way
 * workflow enum — while the thirteen bundled UI skills were still selected by
 * twenty hand-written regexes whose own comment measured them at 5 of 8 real
 * frontend prompts and described the result as "not activation, it is hope".
 *
 * Both questions are about the same sentence, so they belong in the same call.
 * The decision API takes a map of questions and returns a map of answers, which
 * means adding the UI question costs one extra criteria block in the prompt and
 * **zero** extra round trips: same latency budget, same deadline, same backend.
 *
 * Each question is skipped when a free deterministic stage already answered it,
 * so the call shrinks to whatever is genuinely unknown — and vanishes entirely
 * when nothing is.
 */
import { logger } from "@sayknow-cli/utils";
import { BUNDLED_SKC_UI_SKILL_NAMES, type BundledSkcUiSkillName } from "../defaults/skc-ui-skills";
import { BUNDLED_UI_SKILL_MEANINGS } from "../hooks/ui-skill-keywords";
import { CANONICAL_SKC_WORKFLOW_SKILLS, type CanonicalSkcWorkflowSkill } from "../skill-state/active-state";
import type { DecisionService } from "./index";
import {
	buildRoutingCriteria,
	MAX_PROMPT_CHARS,
	MIN_CALIBRATED_CONFIDENCE,
	MIN_PROMPT_CHARS,
	NONE_CHOICE,
	promptSignalLength,
} from "./skill-routing";
import type { Question } from "./types";

const UI_INSTRUCTIONS =
	"Which bundled UI craft skill should be loaded for this request? Choose none unless the request is about building, reviewing, or polishing a user-visible interface.";

/** Exported so tests can assert the contract the model is actually given. */
export function buildUiSkillCriteria(): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const skill of BUNDLED_SKC_UI_SKILL_NAMES) criteria[skill] = BUNDLED_UI_SKILL_MEANINGS[skill];
	criteria[NONE_CHOICE] =
		"Not interface work: backend, data, infrastructure, tooling, SKC's own terminal UI, or a question with no surface to build.";
	return criteria;
}

export interface PromptTriage {
	/** Null means the router deliberately chose no workflow, not that it failed. */
	workflow: CanonicalSkcWorkflowSkill | null;
	uiSkill: BundledSkcUiSkillName | null;
	/** Only meaningful when {@link calibrated} is true. */
	workflowConfidence: number | undefined;
	calibrated: boolean;
}

export interface PromptTriageRequest {
	text: string;
	/** Skip the workflow question — the keyword table already answered it. */
	skipWorkflow?: boolean;
	/** Skip the UI question — the regex table already matched. */
	skipUiSkill?: boolean;
	signal?: AbortSignal | undefined;
}

export type PromptTriager = (request: PromptTriageRequest) => Promise<PromptTriage | null>;

function resolveChoice<T extends string>(
	answer: unknown,
	allowed: readonly T[],
	calibrated: boolean,
	label: string,
): { value: T | null; confidence: number | undefined } {
	const choice = answer as { type?: string; choice?: string; confidence?: number } | undefined;
	if (choice?.type !== "choice") return { value: null, confidence: undefined };
	if (choice.choice === NONE_CHOICE) return { value: null, confidence: choice.confidence };
	const match = allowed.find(candidate => candidate === choice.choice);
	if (!match) return { value: null, confidence: choice.confidence };
	if (calibrated && (choice.confidence ?? 0) < MIN_CALIBRATED_CONFIDENCE) {
		// A floor is only meaningful against a calibrated probability; against an
		// ordinal score it would reject answers that are simply scaled differently.
		logger.debug("decisions/prompt-triage: below confidence floor", {
			question: label,
			choice: choice.choice,
			confidence: choice.confidence,
			floor: MIN_CALIBRATED_CONFIDENCE,
		});
		return { value: null, confidence: choice.confidence };
	}
	return { value: match, confidence: choice.confidence };
}

/**
 * Build the per-turn triager.
 *
 * Returns null when the service is disabled, the prompt is too short to carry
 * intent, every question was already answered for free, or the backend did not
 * produce a usable result. Null means "no information", which is different from
 * a result whose fields are all null — that one is the router saying "none", and
 * the keyword learner treats it as a negative example.
 */
export function createPromptTriage(service: DecisionService): PromptTriager {
	const workflowCriteria = buildRoutingCriteria();
	const uiCriteria = buildUiSkillCriteria();
	return async (request: PromptTriageRequest): Promise<PromptTriage | null> => {
		if (!service.enabled) return null;
		const trimmed = request.text.trim();
		if (promptSignalLength(trimmed) < MIN_PROMPT_CHARS) return null;
		const state = trimmed.length > MAX_PROMPT_CHARS ? trimmed.slice(0, MAX_PROMPT_CHARS) : trimmed;

		const questions: Record<string, Question> = {};
		if (!request.skipWorkflow) {
			questions.workflow = {
				type: "choice",
				instructions:
					"Which workflow should handle this user request? Choose none unless the request clearly calls for one of the workflows.",
				criteria: workflowCriteria,
			};
		}
		if (!request.skipUiSkill) {
			questions.uiSkill = { type: "choice", instructions: UI_INSTRUCTIONS, criteria: uiCriteria };
		}
		if (Object.keys(questions).length === 0) return null;

		const result = await service.decide({ state, questions, signal: request.signal });
		if (!result) return null;

		const workflow = request.skipWorkflow
			? { value: null, confidence: undefined }
			: resolveChoice(result.answers.workflow, CANONICAL_SKC_WORKFLOW_SKILLS, result.calibrated, "workflow");
		const uiSkill = request.skipUiSkill
			? { value: null, confidence: undefined }
			: resolveChoice(result.answers.uiSkill, BUNDLED_SKC_UI_SKILL_NAMES, result.calibrated, "uiSkill");

		logger.debug("decisions/prompt-triage: answered", {
			workflow: workflow.value,
			uiSkill: uiSkill.value,
			backend: result.backend,
			model: result.model,
			calibrated: result.calibrated,
			durationMs: result.durationMs,
		});
		return {
			workflow: workflow.value,
			uiSkill: uiSkill.value,
			workflowConfidence: workflow.confidence,
			calibrated: result.calibrated,
		};
	};
}

export type SkillRouter = (text: string, signal?: AbortSignal) => Promise<CanonicalSkcWorkflowSkill | null>;

/**
 * Workflow-only view of the triager.
 *
 * A few lines over the same implementation rather than a second one: the eval
 * harness in `scripts/eval-skill-routing.ts` and the routing tests want
 * text-in/skill-out and have no UI question to ask, and a parallel router would
 * be free to drift away from the thresholds this one enforces.
 */
export function createSemanticSkillRouter(service: DecisionService): SkillRouter {
	const triage = createPromptTriage(service);
	return async (text: string, signal?: AbortSignal): Promise<CanonicalSkcWorkflowSkill | null> =>
		(await triage({ text, skipUiSkill: true, signal }))?.workflow ?? null;
}
