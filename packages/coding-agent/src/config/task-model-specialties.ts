/**
 * Bounded work-specialty axis for subagent model selection.
 *
 * A canonical role model is a standing guess about the *average* assignment that
 * role gets. The difficulty ladder in `decisions/task-routing.ts` moves that guess
 * when one assignment is unusually hard or unusually mechanical. This axis moves it
 * for a different reason: the assignment belongs to a *kind of work* the user has
 * deliberately picked a model for — backend architecture, frontend design, plain
 * implementation, test work, or review.
 *
 * Specialties are **not agents**. They never appear in agent discovery, task `agent`
 * values, prompts, tool grants, spawn allowlists, or model-profile role keys. The
 * canonical roster stays exactly `executor`, `architect`, `planner`, `critic`, and
 * `default` remains the main-model assignment target. A specialty only ever selects
 * a model for work that is already being routed to one of those roles.
 */
import { normalizeModelSelectorValue } from "./model-selector-value";

/** Stable configuration/routing identifiers. Display strings are localized separately. */
export const TASK_MODEL_SPECIALTY_IDS = [
	"backendArchitecture",
	"frontendDesign",
	"implementation",
	"testing",
	"review",
] as const;

export type TaskModelSpecialty = (typeof TASK_MODEL_SPECIALTY_IDS)[number];

/**
 * Which canonical role agents may receive each specialty.
 *
 * Planning roles share the two design specialties on purpose: the user's intent is
 * "a backend-strong model plans backend work", not "planner and architect each get
 * their own private backend model". Implementation roles never take a design
 * specialty, mirroring the existing frontend-domain rule.
 */
export const TASK_MODEL_SPECIALTY_ROLES: Readonly<Record<TaskModelSpecialty, readonly string[]>> = {
	backendArchitecture: ["planner", "architect"],
	frontendDesign: ["planner", "architect"],
	implementation: ["executor"],
	testing: ["executor"],
	review: ["critic"],
};

/** Neutral classifier outcome: the work does not clearly belong to one specialty. */
export const TASK_MODEL_SPECIALTY_NONE = "none" as const;

/** Bounded-key predicate for the `task.modelRouting.specialtyModels` record. */
export function isTaskModelSpecialty(value: unknown): value is TaskModelSpecialty {
	return typeof value === "string" && (TASK_MODEL_SPECIALTY_IDS as readonly string[]).includes(value);
}

/** Specialties a given canonical role agent is allowed to receive, in declaration order. */
export function specialtiesForRole(agentName: string): TaskModelSpecialty[] {
	return TASK_MODEL_SPECIALTY_IDS.filter(specialty => TASK_MODEL_SPECIALTY_ROLES[specialty].includes(agentName));
}

/** Whether a specialty may be applied to work routed to this canonical role agent. */
export function specialtySupportsRole(specialty: TaskModelSpecialty, agentName: string): boolean {
	return TASK_MODEL_SPECIALTY_ROLES[specialty].includes(agentName);
}

/** Where a composed candidate came from, so a receipt never overstates what was selected. */
export type TaskRoutingSource = "specialty" | "legacy-frontend" | "tier" | "baseline";

export interface TaskRoutingCandidate {
	/** The configured selector, normalized but otherwise untouched. */
	selector: string;
	source: TaskRoutingSource;
	/** Set when `source` is `specialty` or `legacy-frontend`. */
	specialty?: TaskModelSpecialty;
	/** Set when `source` is `tier`. */
	tier?: string;
}

/**
 * Identity used for deduplication.
 *
 * An explicit thinking suffix is part of the identity: `provider/model:high` and
 * `provider/model:low` are different configured intents, and collapsing them would
 * silently drop the user's effort choice from a chain.
 */
export function specialtySelectorIdentity(selector: string): string {
	return selector.trim().toLowerCase();
}

/** The `provider/model` part, ignoring any thinking suffix. Used for "same model" checks. */
export function specialtySelectorHead(selector: string): string {
	return specialtySelectorIdentity(selector).split(":")[0]?.trim() ?? "";
}

/** Expand a configured selector value into normalized candidates tagged with their origin. */
export function toRoutingCandidates(
	value: string | readonly string[] | undefined,
	source: TaskRoutingSource,
	extra?: { specialty?: TaskModelSpecialty; tier?: string },
): TaskRoutingCandidate[] {
	return normalizeModelSelectorValue(value)
		.map(selector => selector.trim())
		.filter(selector => selector.length > 0)
		.map(selector => ({ selector, source, ...extra }));
}

/**
 * Concatenate candidate segments, keeping the first occurrence of each identity.
 *
 * A selector that also exists in the baseline segment is attributed to `baseline`
 * even when an earlier specialty segment introduced it. Resolving that entry proves
 * only that the role's own configured model was usable — reporting it as a specialty
 * hit would claim a routing decision that never happened.
 */
export function dedupeRoutingCandidates(segments: readonly TaskRoutingCandidate[][]): TaskRoutingCandidate[] {
	const flattened = segments.flat();
	const baselineIdentities = new Set(
		flattened.filter(candidate => candidate.source === "baseline").map(c => specialtySelectorIdentity(c.selector)),
	);
	const seen = new Set<string>();
	const deduped: TaskRoutingCandidate[] = [];
	for (const candidate of flattened) {
		const identity = specialtySelectorIdentity(candidate.selector);
		if (seen.has(identity)) continue;
		seen.add(identity);
		deduped.push(
			candidate.source !== "baseline" && baselineIdentities.has(identity)
				? { selector: candidate.selector, source: "baseline" }
				: candidate,
		);
	}
	return deduped;
}
