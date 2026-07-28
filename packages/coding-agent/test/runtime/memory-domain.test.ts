import { describe, expect, it } from "bun:test";
import { computeMemoryGuardDomain } from "../../src/runtime/memory-domain";

function domain(input: {
	effectiveLimitBytes: number;
	totalUsageBytes: number;
	parentBytes: number;
	parentReserveBytes: number;
	workerBytes: number[];
}) {
	return computeMemoryGuardDomain({
		effectiveLimitBytes: input.effectiveLimitBytes,
		totalUsageBytes: input.totalUsageBytes,
		parentBytes: input.parentBytes,
		parentReserveBytes: input.parentReserveBytes,
		workers: input.workerBytes.map((bytes, index) => ({ workerId: `worker-${index + 1}`, bytes })),
	});
}

describe("computeMemoryGuardDomain", () => {
	it("matches the R=0 fixture", () => {
		const snapshot = domain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 80,
			parentBytes: 20,
			parentReserveBytes: 0,
			workerBytes: [60],
		});
		expect(snapshot.headroomBytes).toBe(20);
		expect(snapshot.workerBudgetBytes).toBe(100);
		expect(snapshot.perWorkerAllowanceBytes).toBe(100);
		expect(snapshot.hostExcessBytes).toBe(20);
		expect(snapshot.workers[0]?.excessBytes).toBe(0);
	});

	it("matches the R<P fixture", () => {
		const snapshot = domain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 80,
			parentBytes: 20,
			parentReserveBytes: 10,
			workerBytes: [60],
		});
		expect(snapshot.perWorkerAllowanceBytes).toBe(90);
		expect(snapshot.hostExcessBytes).toBe(10);
		expect(snapshot.workers[0]?.excessBytes).toBe(0);
	});

	it("matches the R>P fixture", () => {
		const snapshot = domain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 80,
			parentBytes: 20,
			parentReserveBytes: 40,
			workerBytes: [60],
		});
		expect(snapshot.perWorkerAllowanceBytes).toBe(60);
		expect(snapshot.hostExcessBytes).toBe(0);
		expect(snapshot.workers[0]?.excessBytes).toBe(0);
	});

	it("matches the worker-overage fixture", () => {
		const snapshot = domain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 80,
			parentBytes: 10,
			parentReserveBytes: 20,
			workerBytes: [55, 15],
		});
		expect(snapshot.perWorkerAllowanceBytes).toBe(40);
		expect(snapshot.hostExcessBytes).toBe(0);
		expect(snapshot.workers[0]?.excessBytes).toBe(15);
		expect(snapshot.workers[1]?.excessBytes).toBe(0);
	});

	it("matches the unmanaged-pressure no-op fixture", () => {
		const snapshot = domain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 90,
			parentBytes: 20,
			parentReserveBytes: 20,
			workerBytes: [20, 20],
		});
		expect(snapshot.unmanagedBytes).toBe(30);
		expect(snapshot.headroomBytes).toBe(10);
		expect(snapshot.perWorkerAllowanceBytes).toBe(25);
		expect(snapshot.hostExcessBytes).toBe(0);
		expect(snapshot.workers[0]?.excessBytes).toBe(0);
		expect(snapshot.workers[1]?.excessBytes).toBe(0);
	});
	it("counts rejected worker bytes as unmanaged pressure", () => {
		const snapshot = computeMemoryGuardDomain({
			effectiveLimitBytes: 100,
			totalUsageBytes: 110,
			parentBytes: 10,
			parentReserveBytes: 10,
			workers: [
				{ workerId: "rejected", bytes: 40, accepted: false },
				{ workerId: "accepted", bytes: 60 },
			],
		});
		expect(snapshot.unmanagedBytes).toBe(40);
		expect(snapshot.perWorkerAllowanceBytes).toBe(50);
		expect(snapshot.workers[1]?.excessBytes).toBe(10);
	});
});
