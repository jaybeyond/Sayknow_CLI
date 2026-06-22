/** Native-free canonical SKC workflow skill identifiers. */
export const CANONICAL_SKC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;

export type CanonicalSkcWorkflowSkill = (typeof CANONICAL_SKC_WORKFLOW_SKILLS)[number];
