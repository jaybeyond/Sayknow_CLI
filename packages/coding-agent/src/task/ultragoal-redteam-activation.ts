/**
 * Decide whether an executor assignment should inject the ultragoal red-team
 * prompt fragment.
 *
 * Preference order (parse, don't re-validate later):
 * 1. Explicit typed `executionMode` on the task / ExecutorOptions — authoritative.
 * 2. Assignment text heuristics — only explicit Ultragoal QA/red-team phrasing.
 *
 * Bare mentions of `executorQa` (docs, quality-gate field names, negative
 * instructions) must not flip the mode (#2698 / #2456).
 *
 * Mirrors `executor.md`:
 * "activates only when the assignment explicitly labels Executor as Ultragoal
 * completion QA/red-team or asks for `executorQa` red-team evidence."
 */

export const EXECUTOR_EXECUTION_MODES = ["default", "ultragoal-red-team"] as const;
export type ExecutorExecutionMode = (typeof EXECUTOR_EXECUTION_MODES)[number];

const ULTRAGOAL_COMPLETION_QA = /\bultragoal\s+completion\s+(?:qa|red[-\s]?team)\b/i;

/** `executorQa` within a short window of red-team / matrix / evidence framing. */
const EXECUTOR_QA_EVIDENCE =
	/\bexecutorQa\b[\s\S]{0,120}\b(?:red[-\s]?team|matrix|evidence)\b|\b(?:red[-\s]?team|matrix|evidence)\b[\s\S]{0,120}\bexecutorQa\b/i;

/** Common Ultragoal skill spawn phrasing: "executor QA/red-team lane". */
const EXECUTOR_QA_LANE = /\bexecutor\b[\s\S]{0,48}\b(?:qa|red[-\s]?team)\s+lane\b/i;

export function isExecutorExecutionMode(value: unknown): value is ExecutorExecutionMode {
	return value === "default" || value === "ultragoal-red-team";
}

/**
 * Parse a caller-supplied mode. Unknown values fail closed to `undefined`
 * so the assignment heuristic (or default off) still applies — never invent on.
 */
export function parseExecutorExecutionMode(value: unknown): ExecutorExecutionMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replaceAll("_", "-");
	if (normalized === "default" || normalized === "ordinary" || normalized === "implement") {
		return "default";
	}
	if (
		normalized === "ultragoal-red-team" ||
		normalized === "ultragoal-redteam" ||
		normalized === "red-team" ||
		normalized === "redteam" ||
		normalized === "executor-qa"
	) {
		return "ultragoal-red-team";
	}
	return undefined;
}

export function assignmentRequestsUltragoalRedTeam(assignment: string | undefined): boolean {
	const text = assignment?.trim() ?? "";
	if (text.length === 0) return false;
	return ULTRAGOAL_COMPLETION_QA.test(text) || EXECUTOR_QA_EVIDENCE.test(text) || EXECUTOR_QA_LANE.test(text);
}

export interface ResolveUltragoalRedTeamArgs {
	readonly executionMode?: unknown;
	readonly assignment?: string;
}

/**
 * Final activation decision for the executor prompt fragment.
 * Typed mode wins; assignment text is a compatibility fallback only.
 */
export function resolveUltragoalRedTeamActivation(args: ResolveUltragoalRedTeamArgs): boolean {
	const mode = parseExecutorExecutionMode(args.executionMode);
	if (mode === "ultragoal-red-team") return true;
	if (mode === "default") return false;
	return assignmentRequestsUltragoalRedTeam(args.assignment);
}
