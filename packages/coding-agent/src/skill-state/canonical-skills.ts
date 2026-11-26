/** Native-free canonical SKC workflow skill identifiers. */
export const CANONICAL_SKC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;

export type CanonicalSkcWorkflowSkill = (typeof CANONICAL_SKC_WORKFLOW_SKILLS)[number];

export const SKC_WORKFLOW_PUBLIC_NAMES = {
	"deep-interview": "sonar",
	ralplan: "blueprint",
	ultragoal: "voyage",
	team: "octo",
} as const satisfies Record<CanonicalSkcWorkflowSkill, string>;

export function resolveSkcWorkflowId(name: string): CanonicalSkcWorkflowSkill | undefined {
	return CANONICAL_SKC_WORKFLOW_SKILLS.find(id => name === id || name === SKC_WORKFLOW_PUBLIC_NAMES[id]);
}

export function getSkcWorkflowPublicName(name: string): string {
	const id = resolveSkcWorkflowId(name);
	return id ? SKC_WORKFLOW_PUBLIC_NAMES[id] : name;
}

export function isReservedSkcWorkflowCommand(name: string): boolean {
	return name.startsWith("skill:") && resolveSkcWorkflowId(name.slice(6)) !== undefined;
}
