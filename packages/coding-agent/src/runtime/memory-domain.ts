import type {
	MemoryGuardDomainSnapshot,
	MemoryGuardWorkerAccounting,
	MemoryGuardWorkerSample,
} from "./memory-guard-contract";

export interface MemoryGuardDomainInput {
	effectiveLimitBytes: number;
	totalUsageBytes: number;
	parentBytes: number;
	parentReserveBytes: number;
	workers: readonly MemoryGuardWorkerSample[];
}

function assertNonNegativeSafeInteger(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${name}`);
	return value;
}

function sumWorkerBytes(workers: readonly MemoryGuardWorkerSample[]): number {
	let total = 0;
	for (const worker of workers) {
		total += assertNonNegativeSafeInteger(`worker_bytes:${worker.workerId}`, worker.bytes);
		if (!Number.isSafeInteger(total)) throw new Error("invalid_worker_total_bytes");
	}
	return total;
}

export function computeMemoryGuardDomain(input: MemoryGuardDomainInput): MemoryGuardDomainSnapshot {
	const effectiveLimitBytes = assertNonNegativeSafeInteger("effective_limit_bytes", input.effectiveLimitBytes);
	const totalUsageBytes = assertNonNegativeSafeInteger("total_usage_bytes", input.totalUsageBytes);
	const parentBytes = assertNonNegativeSafeInteger("parent_bytes", input.parentBytes);
	const parentReserveBytes = assertNonNegativeSafeInteger("parent_reserve_bytes", input.parentReserveBytes);
	const totalWorkerBytes = sumWorkerBytes(input.workers);
	const acceptedWorkers = input.workers.filter(worker => worker.accepted !== false);
	const acceptedWorkerBytes = sumWorkerBytes(acceptedWorkers);
	const acceptedWorkerCount = acceptedWorkers.length;
	const unmanagedBytes = Math.max(0, totalUsageBytes - parentBytes - acceptedWorkerBytes);
	const headroomBytes = Math.max(0, effectiveLimitBytes - totalUsageBytes);
	const workerBudgetBytes = Math.max(0, effectiveLimitBytes - unmanagedBytes - parentReserveBytes);
	const perWorkerAllowanceBytes = acceptedWorkerCount === 0 ? 0 : workerBudgetBytes / acceptedWorkerCount;
	const workers: MemoryGuardWorkerAccounting[] = input.workers.map(worker => {
		const accepted = worker.accepted !== false;
		return {
			workerId: worker.workerId,
			bytes: worker.bytes,
			accepted,
			allowanceBytes: accepted ? perWorkerAllowanceBytes : 0,
			excessBytes: accepted ? Math.max(0, worker.bytes - perWorkerAllowanceBytes) : 0,
		};
	});
	return {
		effectiveLimitBytes,
		totalUsageBytes,
		parentBytes,
		parentReserveBytes,
		totalWorkerBytes,
		acceptedWorkerCount,
		unmanagedBytes,
		headroomBytes,
		workerBudgetBytes,
		perWorkerAllowanceBytes,
		hostExcessBytes: Math.max(0, parentBytes - parentReserveBytes),
		workers,
	};
}
