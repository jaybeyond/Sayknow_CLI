import { CANONICAL_SKC_WORKFLOW_SKILLS, type CanonicalSkcWorkflowSkill } from "../skill-state/active-state";

export interface SkillKeywordDefinition {
	keyword: string;
	skill: SkcWorkflowSkill;
	priority: number;
	guidance: string;
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
