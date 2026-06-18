import * as path from "node:path";
import { CANONICAL_SKC_WORKFLOW_SKILLS, type CanonicalSkcWorkflowSkill, SKILL_ACTIVE_STATE_FILE } from "./active-state";
import { WORKFLOW_STATE_RECEIPT_FRESH_MS, WORKFLOW_STATE_RECEIPT_VERSION } from "./workflow-state-version";

export {
	WORKFLOW_STATE_RECEIPT_FRESH_MS,
	WORKFLOW_STATE_RECEIPT_VERSION,
	WORKFLOW_STATE_VERSION,
} from "./workflow-state-version";

export type { CanonicalSkcWorkflowSkill };
export type WorkflowStateMutationOwner = "skc-state-cli" | "skc-runtime" | "skc-hook";
export type WorkflowStateReceiptStatus = "fresh" | "stale";

export interface WorkflowStateContentChecksum {
	algorithm: "sha256";
	value: string;
	covered_path: string;
	computed_at: string;
}

export interface WorkflowStateReceipt {
	version: 1;
	skill: CanonicalSkcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	state_path: string;
	storage_path: string;
	mutated_at: string;
	fresh_until: string;
	status: WorkflowStateReceiptStatus;
	mutation_id: string;
	verb?: string;
	from_phase?: string;
	to_phase?: string;
	forced?: boolean;
	paths?: string[];
	content_sha256?: WorkflowStateContentChecksum;
}

export interface AuditEntry {
	ts: string;
	skill?: string;
	category: string;
	verb: string;
	owner: WorkflowStateMutationOwner;
	mutation_id: string;
	from_phase?: string;
	to_phase?: string;
	forced: boolean;
	paths: string[];
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function workflowModeStateFileName(skill: CanonicalSkcWorkflowSkill): string {
	return `${skill}-state.json`;
}

export function workflowStateStoragePath(cwd: string, skill: CanonicalSkcWorkflowSkill, sessionId?: string): string {
	const normalizedSessionId = safeString(sessionId).trim();
	if (normalizedSessionId) {
		return path.join(
			cwd,
			".skc",
			"state",
			"sessions",
			encodePathSegment(normalizedSessionId),
			workflowModeStateFileName(skill),
		);
	}
	return path.join(cwd, ".skc", "state", workflowModeStateFileName(skill));
}

export function workflowActiveStatePath(cwd: string, sessionId?: string): string {
	const normalizedSessionId = safeString(sessionId).trim();
	if (normalizedSessionId) {
		return path.join(
			cwd,
			".skc",
			"state",
			"sessions",
			encodePathSegment(normalizedSessionId),
			SKILL_ACTIVE_STATE_FILE,
		);
	}
	return path.join(cwd, ".skc", "state", SKILL_ACTIVE_STATE_FILE);
}

export function buildWorkflowStateReceipt(input: {
	cwd: string;
	skill: CanonicalSkcWorkflowSkill;
	owner: WorkflowStateMutationOwner;
	command: string;
	sessionId?: string;
	nowIso?: string;
	mutationId?: string;
}): WorkflowStateReceipt {
	const mutatedAt = input.nowIso ?? new Date().toISOString();
	const freshUntil = new Date(Date.parse(mutatedAt) + WORKFLOW_STATE_RECEIPT_FRESH_MS).toISOString();
	return {
		version: WORKFLOW_STATE_RECEIPT_VERSION,
		skill: input.skill,
		owner: input.owner,
		command: input.command,
		state_path: workflowActiveStatePath(input.cwd, input.sessionId),
		storage_path: workflowStateStoragePath(input.cwd, input.skill, input.sessionId),
		mutated_at: mutatedAt,
		fresh_until: freshUntil,
		status: "fresh",
		mutation_id: input.mutationId ?? `${input.skill}:${mutatedAt}`,
	};
}

export function workflowReceiptStatus(
	receipt: WorkflowStateReceipt | undefined,
	nowMs = Date.now(),
): WorkflowStateReceiptStatus | undefined {
	if (!receipt) return undefined;
	const freshUntilMs = Date.parse(receipt.fresh_until);
	if (!Number.isFinite(freshUntilMs)) return "stale";
	return nowMs <= freshUntilMs ? "fresh" : "stale";
}

export function canonicalWorkflowSkill(value: string): CanonicalSkcWorkflowSkill | null {
	return (CANONICAL_SKC_WORKFLOW_SKILLS as readonly string[]).includes(value)
		? (value as CanonicalSkcWorkflowSkill)
		: null;
}

export function sanctionedWorkflowStateCommand(skill: CanonicalSkcWorkflowSkill): string {
	return `skc state ${skill} write --input '<json>'`;
}

export function describeWorkflowStateContract(skill: CanonicalSkcWorkflowSkill): string[] {
	return [
		`Sanctioned mutation path: skc state ${skill} read|write --input '<json>'`,
		`Canonical active HUD state: .skc/state/${SKILL_ACTIVE_STATE_FILE} and .skc/state/sessions/<session>/${SKILL_ACTIVE_STATE_FILE}`,
		`Skill mode state: .skc/state/${workflowModeStateFileName(skill)} or .skc/state/sessions/<session>/${workflowModeStateFileName(skill)}`,
		"Receipts include version, skill, owner, command, state_path, storage_path, mutated_at, fresh_until, status, and mutation_id.",
		"Receipts are fresh for 30 minutes; older receipts are stale and render as HUD warnings.",
		"Planning artifacts under .skc/specs/** and .skc/plans/** remain writable outside the state command.",
	];
}
