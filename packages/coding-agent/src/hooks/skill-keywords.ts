import { CANONICAL_SKC_WORKFLOW_SKILLS, type CanonicalSkcWorkflowSkill } from "../skill-state/active-state";

export interface SkillKeywordDefinition {
	keyword: string;
	skill: SkcWorkflowSkill;
	priority: number;
	guidance: string;
	/**
	 * Pre-compiled matcher, replacing the literal-substring compilation of
	 * `keyword`. Only learned entries set it: they are two stems with a bounded
	 * gap, which a literal string cannot express. `keyword` stays human-readable
	 * for logs and for the guidance line.
	 */
	pattern?: RegExp;
	/** Mined from routing answers rather than written by hand. */
	learned?: boolean;
}

export const SKC_WORKFLOW_SKILLS = CANONICAL_SKC_WORKFLOW_SKILLS;

export type SkcWorkflowSkill = CanonicalSkcWorkflowSkill;

export const SKC_SKILL_KEYWORD_DEFINITIONS: readonly SkillKeywordDefinition[] = [
	{
		keyword: "$deep-interview",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	{
		keyword: "deep interview",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	{
		keyword: "interview me",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	{
		keyword: "don't assume",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	// Korean counterparts. The table was English-only, which is why the deterministic
	// stage recalled 0/9 on Korean prompts while scoring 4/8 on English ones — the gap
	// was never about phrasing being harder to detect, it was about nobody enumerating it.
	//
	// These stay deliberately narrow. A keyword fires with full authority and no
	// confidence to fall back on, so a loose phrase here activates a workflow the user
	// never asked for — worse than missing one, because the semantic stage still catches
	// paraphrases behind it.
	{
		keyword: "추측하지 말",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	{
		keyword: "인터뷰하듯",
		skill: "deep-interview",
		priority: 8,
		guidance: "Activate SKC deep-interview requirements workflow",
	},
	{
		keyword: "$ralplan",
		skill: "ralplan",
		priority: 9,
		guidance: "Activate SKC ralplan planning workflow",
	},
	{
		keyword: "consensus plan",
		skill: "ralplan",
		priority: 9,
		guidance: "Activate SKC ralplan planning workflow",
	},
	{
		keyword: "합의된 계획",
		skill: "ralplan",
		priority: 9,
		guidance: "Activate SKC ralplan planning workflow",
	},
	{
		keyword: "계획서 만들",
		skill: "ralplan",
		priority: 9,
		guidance: "Activate SKC ralplan planning workflow",
	},
	{
		keyword: "$ultragoal",
		skill: "ultragoal",
		priority: 8,
		guidance: "Activate SKC ultragoal durable goal workflow",
	},
	{
		keyword: "ultragoal",
		skill: "ultragoal",
		priority: 8,
		guidance: "Activate SKC ultragoal durable goal workflow",
	},
	{
		keyword: "끝까지 추적",
		skill: "ultragoal",
		priority: 8,
		guidance: "Activate SKC ultragoal durable goal workflow",
	},
	{
		keyword: "장기 목표로",
		skill: "ultragoal",
		priority: 8,
		guidance: "Activate SKC ultragoal durable goal workflow",
	},
	{
		keyword: "$team",
		skill: "team",
		priority: 8,
		guidance: "Activate SKC team workflow",
	},
	{
		keyword: "coordinated team",
		skill: "team",
		priority: 8,
		guidance: "Activate SKC team workflow",
	},
	{
		keyword: "병렬로 돌려",
		skill: "team",
		priority: 8,
		guidance: "Activate SKC team workflow",
	},
	{
		keyword: "팀 구성해서",
		skill: "team",
		priority: 8,
		guidance: "Activate SKC team workflow",
	},
] as const;

export function isSkcWorkflowSkill(value: string): value is SkcWorkflowSkill {
	return (SKC_WORKFLOW_SKILLS as readonly string[]).includes(value);
}

export function compareSkillKeywordMatches(
	a: { priority: number; keyword: string },
	b: { priority: number; keyword: string },
): number {
	if (b.priority !== a.priority) return b.priority - a.priority;
	if (b.keyword.length !== a.keyword.length) return b.keyword.length - a.keyword.length;
	return a.keyword.localeCompare(b.keyword);
}
