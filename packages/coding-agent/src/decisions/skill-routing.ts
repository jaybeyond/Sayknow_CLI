/**
 * Semantic fallback for workflow-skill routing.
 *
 * The keyword table in `hooks/skill-keywords.ts` is thirteen literal strings. It is
 * exact and free, and it is the right first stage — but measured against realistic
 * paraphrases it recalls 4/17, and **0/9 in Korean**, which is most of our users. A
 * miss is not fatal (the model still sees the routing rules in the system prompt), but
 * it means the deterministic gate simply does not exist for those prompts.
 *
 * This module fills that gap only where the keyword stage produced nothing:
 *
 *   keyword (exact, free) -> semantic (this, one cheap call) -> system prompt (as today)
 *
 * The two stages fail in opposite directions, which is why both are kept. Measured on
 * the same 22 prompts, the literal stage is the one that catches `ultragoal this` and
 * `consensus plan`; the semantic stage is the one that catches everything Korean.
 */
import { logger } from "@sayknow-cli/utils";
import { CANONICAL_SKC_WORKFLOW_SKILLS, type CanonicalSkcWorkflowSkill } from "../skill-state/active-state";
import type { DecisionService } from "./index";

const NONE = "none";

/**
 * What each workflow is *for*, in the words a user would recognise. These descriptions
 * are the whole contract with the model — the enum ids alone carry almost no signal.
 */
const WORKFLOW_MEANINGS: Record<CanonicalSkcWorkflowSkill, string> = {
	// Scoped to the *behaviour* the user is asking for, not only to the state of the
	// request. The earlier wording ("vague about what to build") described a property of
	// the spec, so a direct instruction to ask rather than assume — the request is not
	// vague, it is an order about how to proceed — landed on `none`. Measured: that one
	// prompt was the sole miss in the 23-case set.
	"deep-interview":
		"The user wants requirements drawn out of them by questioning before anything is built. Includes explicit instructions to ask rather than assume.",
	ralplan:
		"The user wants a deliberate plan, design comparison, or approval before any code is touched. Architecture or sequencing risk is involved.",
	ultragoal:
		"The user wants an objective tracked in a durable ledger across many turns until every deliverable is verified.",
	team: "The work is large enough to split across several coordinated workers running in parallel.",
};

const ROUTING_INSTRUCTIONS =
	"Which workflow should handle this user request? Choose none unless the request clearly calls for one of the workflows.";

/** Exported so tests can assert the contract the model is actually given. */
export function buildRoutingCriteria(): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const skill of CANONICAL_SKC_WORKFLOW_SKILLS) criteria[skill] = WORKFLOW_MEANINGS[skill];
	criteria[NONE] =
		"An ordinary request: a question, a bug fix, a small edit, or anything that should just be handled directly.";
	return criteria;
}

/** Prompts below this length never carry enough signal to justify a model round-trip. */
const MIN_PROMPT_CHARS = 12;
/** Only the opening of a prompt decides its workflow; the rest is payload. */
const MAX_PROMPT_CHARS = 4_000;

/**
 * Minimum calibrated confidence required to activate a workflow.
 *
 * Activation is a strong move: it switches on the mutation guard, the Stop hook and the
 * ask tool. Getting it wrong is worse than missing, because the user did not ask for any
 * of that and has no obvious way to see why it appeared.
 *
 * Measured over ten routing prompts against the hosted model: every answer it reported
 * at 1.00 was correct, and its single wrong answer reported 0.71. The lowest *correct*
 * confidence was 0.67 — and that case was "none", so gating it out costs nothing. A
 * floor here therefore removes the observed error without removing a real activation.
 *
 * One prompt sits close to this line. "추측하지 말고 모르는 건 다 물어봐" resolves to
 * deep-interview in 8/8 samples but at 0.76-0.83, so the floor has roughly 0.01 of
 * headroom on it. Raising the floor would drop a correct activation; lowering it would
 * re-admit the 0.71 error. Treat 0.75 as fitted to a small sample and re-derive it from
 * real usage rather than nudging it on a hunch.
 *
 * Only applied when the backend reports `calibrated: true`. An ordinary LLM answering
 * through a forced enum has no meaningful confidence to compare against, so gating on a
 * number it did not really produce would just be superstition.
 */
const MIN_CALIBRATED_CONFIDENCE = 0.75;

export type SkillRouter = (text: string) => Promise<CanonicalSkcWorkflowSkill | null>;

/**
 * Build the semantic router. Returns null-resolving function when the service is
 * disabled so the caller keeps its existing behaviour with no branching.
 */
export function createSemanticSkillRouter(service: DecisionService): SkillRouter {
	const criteria = buildRoutingCriteria();
	return async (text: string): Promise<CanonicalSkcWorkflowSkill | null> => {
		if (!service.enabled) return null;
		const trimmed = text.trim();
		if (trimmed.length < MIN_PROMPT_CHARS) return null;
		const state = trimmed.length > MAX_PROMPT_CHARS ? trimmed.slice(0, MAX_PROMPT_CHARS) : trimmed;

		const result = await service.decide({
			state,
			questions: { workflow: { type: "choice", instructions: ROUTING_INSTRUCTIONS, criteria } },
		});
		const answer = result?.answers.workflow;
		if (!result || answer?.type !== "choice" || answer.choice === NONE) return null;
		const skill = CANONICAL_SKC_WORKFLOW_SKILLS.find(candidate => candidate === answer.choice);
		if (!skill) return null;
		if (result.calibrated && (answer.confidence ?? 0) < MIN_CALIBRATED_CONFIDENCE) {
			logger.debug("decisions/skill-routing: below confidence floor, leaving routing alone", {
				skill,
				confidence: answer.confidence,
				floor: MIN_CALIBRATED_CONFIDENCE,
			});
			return null;
		}
		logger.debug("decisions/skill-routing: semantic match", {
			skill,
			backend: result.backend,
			confidence: answer.confidence,
			calibrated: result.calibrated,
			durationMs: result.durationMs,
		});
		return skill;
	};
}
