export interface MemoryGuardPolicy {
	enabled: boolean;
	checkIntervalMs: number;
	gcThresholdRatio: number;
	restartThresholdRatio: number;
	restartThresholdWindowMs: number;
	cooldownMs: number;
	parentReserveBytes: number;
	policyLimitBytes: number | null;
}

export interface MemoryGuardWorkerSample {
	workerId: string;
	bytes: number;
	accepted?: boolean;
}

export interface MemoryGuardWorkerAccounting {
	workerId: string;
	bytes: number;
	accepted: boolean;
	allowanceBytes: number;
	excessBytes: number;
}

export interface MemoryGuardDomainSnapshot {
	effectiveLimitBytes: number;
	totalUsageBytes: number;
	parentBytes: number;
	parentReserveBytes: number;
	totalWorkerBytes: number;
	acceptedWorkerCount: number;
	unmanagedBytes: number;
	headroomBytes: number;
	workerBudgetBytes: number;
	perWorkerAllowanceBytes: number;
	hostExcessBytes: number;
	workers: MemoryGuardWorkerAccounting[];
}

export interface MemoryGuardHostTarget {
	kind: "host";
	excessBytes: number;
}

export interface MemoryGuardWorkerTarget {
	kind: "worker";
	workerId: string;
	excessBytes: number;
}

export type MemoryGuardActionTarget = MemoryGuardHostTarget | MemoryGuardWorkerTarget;

export type MemoryGuardNoopReason =
	| "memory_guard_action_noop_unmanaged_or_within_allowance"
	| "memory_guard_action_noop_unsupported";

export type MemoryGuardDecision =
	| { kind: "execute"; target: MemoryGuardActionTarget }
	| { kind: "noop"; reason: MemoryGuardNoopReason }
	| { kind: "revalidated_out"; reason: "memory_guard_action_revalidated_out" };

export interface MemoryGuardSchedulerState {
	timerActive: boolean;
	registrationCount: number;
	inProgress: boolean;
	generation: number;
	pendingDeadline: number | null;
	pendingOwner: { generation: number; token: number } | null;
	deferredDeadline: number | null;
	deferredGeneration: number | null;
	activeGeneration: number | null;
}
