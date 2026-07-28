import { describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { computeMemoryGuardDomain } from "../../src/runtime/memory-domain";
import {
	chooseMemoryGuardAction,
	MemoryGuardHost,
	resolveMemoryGuardPolicy,
	revalidateMemoryGuardAction,
} from "../../src/runtime/memory-guard";
import { __sampleWindowsJobMemoryForTest } from "../../src/tools/resource-gc";

describe("resolveMemoryGuardPolicy", () => {
	it("stays disabled by default and converts MB values to bytes", () => {
		const policy = resolveMemoryGuardPolicy(Settings.isolated({}));
		expect(policy).toMatchObject({
			enabled: false,
			checkIntervalMs: 30_000,
			gcThresholdRatio: 0.7,
			restartThresholdRatio: 0.85,
			restartThresholdWindowMs: 90_000,
			cooldownMs: 600_000,
			parentReserveBytes: 1024 * 1024 * 1024,
			policyLimitBytes: null,
		});
	});

	it("rounds fractional megabyte settings to integer bytes", () => {
		const policy = resolveMemoryGuardPolicy(
			Settings.isolated({
				"memoryGuard.policyLimitMb": 100.1,
				"memoryGuard.parentReserveMb": 10.25,
			}),
		);
		expect(policy.policyLimitBytes).toBe(Math.round(100.1 * 1024 * 1024));
		expect(policy.parentReserveBytes).toBe(Math.round(10.25 * 1024 * 1024));
	});
});

describe("memory guard arbitration", () => {
	it("does not let an unsupported host candidate mask an executable worker candidate", () => {
		const decision = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 55 },
					{ workerId: "worker-2", bytes: 15 },
				],
			}),
			hostSupported: false,
			workerSupported: workerId => workerId === "worker-1",
		});
		expect(decision).toEqual({ kind: "execute", target: { kind: "worker", workerId: "worker-1", excessBytes: 15 } });
	});

	it("revalidates out when the selected target is no longer over allowance", () => {
		const initial = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 55 },
					{ workerId: "worker-2", bytes: 15 },
				],
			}),
			hostSupported: false,
			workerSupported: () => true,
		});
		if (initial.kind !== "execute") throw new Error("expected an initial executable target");
		const revalidated = chooseMemoryGuardAction({
			domain: computeMemoryGuardDomain({
				effectiveLimitBytes: 100,
				totalUsageBytes: 80,
				parentBytes: 10,
				parentReserveBytes: 20,
				workers: [
					{ workerId: "worker-1", bytes: 40 },
					{ workerId: "worker-2", bytes: 30 },
				],
			}),
			hostSupported: false,
			workerSupported: () => true,
		});
		expect(revalidateMemoryGuardAction(initial, revalidated)).toEqual({
			kind: "revalidated_out",
			reason: "memory_guard_action_revalidated_out",
		});
	});
});

describe("MemoryGuardHost", () => {
	it("serializes action execution so only one run is in flight", async () => {
		const gate = Promise.withResolvers<void>();
		const run = vi.fn(async () => {
			await gate.promise;
		});
		const host = new MemoryGuardHost({ run });
		const unregister = host.register({ ownerId: "worker-1", intervalMs: 100 });
		const first = host.runTick();
		await Promise.resolve();
		await host.runTick();
		expect(run).toHaveBeenCalledTimes(1);
		gate.resolve();
		await first;
		unregister();
	});

	it("schedules based on earliest per-registration due time", async () => {
		let now = 1000;
		const host = new MemoryGuardHost({
			run: async () => {},
			schedulerNow: () => now,
		});
		const unregA = host.register({ ownerId: "session-a", intervalMs: 5_000 });
		const unregB = host.register({ ownerId: "session-b", intervalMs: 30_000 });
		let state = host.getStateForTest();
		expect(state.pendingDeadline).toBe(6_000);

		// Advance past session-a's deadline and trigger timer callback
		now = 6_000;
		await host.runTimerCallbackForTest({ generation: state.generation, token: state.pendingOwner!.token }, 6_000);
		state = host.getStateForTest();
		// session-a next due is now 6_000 + 5_000 = 11_000, session-b next due is 1_000 + 30_000 = 31_000
		expect(state.pendingDeadline).toBe(11_000);

		// Updating interval for session-a reschedules to the new earliest due time
		host.updateInterval("session-a", 15_000);
		state = host.getStateForTest();
		expect(state.pendingDeadline).toBe(21_000);

		unregA();
		unregB();
	});

	it("defers scheduling when a tick is in progress", async () => {
		const now = 1000;
		const gate = Promise.withResolvers<void>();
		const host = new MemoryGuardHost({
			run: async () => {
				await gate.promise;
			},
			schedulerNow: () => now,
		});
		const unreg = host.register({ ownerId: "session-a", intervalMs: 5_000 });
		const tickPromise = host.runTick();
		const state = host.getStateForTest();
		expect(state.inProgress).toBe(true);

		// Second registration while in-progress defers schedule
		host.register({ ownerId: "session-b", intervalMs: 2_000 });
		const stateDeferred = host.getStateForTest();
		expect(stateDeferred.pendingDeadline).toBe(3_000);

		gate.resolve();
		await tickPromise;
		const finalState = host.getStateForTest();
		expect(finalState.inProgress).toBe(false);
		expect(finalState.pendingDeadline).toBe(3_000);

		unreg();
	});
});

describe("__sampleWindowsJobMemoryForTest", () => {
	it("samples uncapped Job Object without clamping to physical RAM", () => {
		const ram16Gb = 16 * 1024 * 1024 * 1024;
		const rss2Gb = 2 * 1024 * 1024 * 1024;
		const commit20Gb = 20 * 1024 * 1024 * 1024;
		const snapshot = __sampleWindowsJobMemoryForTest(ram16Gb, rss2Gb, {
			kind: "job_snapshot",
			platform: "win32",
			isInJob: true,
			jobMemoryUsedBytes: String(commit20Gb),
			processWorkingSetBytes: String(rss2Gb),
			processPrivateUsageBytes: String(rss2Gb),
		});

		if (!snapshot) throw new Error("expected snapshot");
		const jobDomain = snapshot.domains?.find(d => d.source === "windows_job");
		expect(jobDomain).toBeDefined();
		expect(jobDomain?.hardCapBytes).toBe(Number.MAX_SAFE_INTEGER);
		expect(jobDomain?.totalUsageBytes).toBe(commit20Gb);

		const policyLimit24Gb = 24 * 1024 * 1024 * 1024;
		const usageRatio = snapshot.totalUsageBytes / policyLimit24Gb;

		expect(usageRatio).toBeLessThan(1);
	});

	it("samples capped Job Object and process working set domains", () => {
		const ram16Gb = 16 * 1024 * 1024 * 1024;
		const rss2Gb = 2 * 1024 * 1024 * 1024;
		const jobLimit8Gb = 8 * 1024 * 1024 * 1024;
		const jobUsage4Gb = 4 * 1024 * 1024 * 1024;
		const snapshot = __sampleWindowsJobMemoryForTest(ram16Gb, rss2Gb, {
			kind: "job_snapshot",
			platform: "win32",
			isInJob: true,
			jobMemoryLimitBytes: String(jobLimit8Gb),
			jobMemoryUsedBytes: String(jobUsage4Gb),
			processMemoryLimitBytes: String(jobLimit8Gb),
			processPrivateUsageBytes: String(rss2Gb),
			processWorkingSetBytes: String(rss2Gb),
		});

		if (!snapshot) throw new Error("expected snapshot");
		const jobDomain = snapshot.domains?.find(d => d.source === "windows_job");
		expect(jobDomain).toBeDefined();
		expect(jobDomain?.hardCapBytes).toBe(jobLimit8Gb);
		expect(jobDomain?.totalUsageBytes).toBe(jobUsage4Gb);
	});

	it("returns null for non-job_snapshot probe results", () => {
		expect(
			__sampleWindowsJobMemoryForTest(1000, 100, {
				kind: "unsupported_platform",
				platform: "linux",
			}),
		).toBeNull();
		expect(
			__sampleWindowsJobMemoryForTest(1000, 100, {
				kind: "not_in_job",
				platform: "win32",
				isInJob: false,
			}),
		).toBeNull();
	});
});
