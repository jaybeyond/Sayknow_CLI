import type { CanonicalSkcWorkflowSkill } from "./active-state";

/**
 * Canonical initial phase for each SKC workflow skill. Used by both
 * `recordSkillActivation` (UserPromptSubmit hook seeding initial mode-state)
 * and the `skc state <caller> handoff --to <callee>` runtime when promoting
 * the callee.
 *
 * Keeping this mapping in a neutral skill-state module avoids cycles between
 * `skc-runtime/state-runtime.ts` and `hooks/skill-state.ts` (which pulls in
 * session-manager and ultragoal verification code).
 */
export function initialPhaseForSkill(skill: CanonicalSkcWorkflowSkill | string): string {
	if (skill === "deep-interview") return "interviewing";
	if (skill === "ultragoal") return "goal-planning";
	if (skill === "ralplan") return "planner";
	if (skill === "team") return "starting";
	return "planning";
}
