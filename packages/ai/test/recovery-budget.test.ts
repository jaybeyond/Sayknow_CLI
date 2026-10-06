import { describe, expect, it, spyOn } from "bun:test";
import {
	createUpstreamAdmission,
	type FetchImpl,
	isRecoveryAdmissionErrorMessage,
	RecoveryAdmissionError,
	RecoveryBudget,
	type RecoveryRequestKind,
	SAME_MODEL_RECOVERY_MAX_REQUESTS,
	SAME_MODEL_RECOVERY_WINDOW_MS,
} from "@sayknow-cli/ai";

function rejection(action: () => unknown): string | undefined {
	try {
		action();
		return undefined;
	} catch (error) {
		return error instanceof RecoveryAdmissionError ? error.reason : String(error);
	}
}

describe("RecoveryBudget", () => {
	it("admits the original request plus six recovery requests and never refunds capacity", () => {
		const budget = new RecoveryBudget({ now: () => 1_000 });
		const kinds = ["token", "inference", "token", "resend", "inference", "inference", "inference"] as const;

		expect(SAME_MODEL_RECOVERY_MAX_REQUESTS).toBe(7);
		expect(kinds.map(kind => budget.reserve(kind))).toEqual(
			kinds.map((kind, index) => ({ kind, requestNumber: index + 1 })),
		);
		expect(rejection(() => budget.reserve("inference"))).toBe("request_limit");
		budget.recordRecoverableFailure();
		expect(budget.snapshot()).toEqual({
			usedRequests: 7,
			maxRequests: 7,
			silentTimeouts: 0,
			firstFailureAtMs: 1_000,
			deadlineAtMs: 1_000 + SAME_MODEL_RECOVERY_WINDOW_MS,
		});
	});

	it("closes admission after consecutive no-output timeouts on one selector", () => {
		const budget = new RecoveryBudget();
		const silent = { silentTimeout: true, progressed: false, selector: "a/m" };
		expect(budget.recordAttemptOutcome(silent)).toBe(false);
		expect(budget.recordAttemptOutcome(silent)).toBe(false);
		expect(budget.recordAttemptOutcome(silent)).toBe(true);
		expect(budget.canAdmit()).toBe(false);
		expect(rejection(() => budget.reserve("inference"))).toBe("silent_stall");
		expect(isRecoveryAdmissionErrorMessage(new RecoveryAdmissionError("silent_stall").message)).toBe(true);
		expect(budget.snapshot().usedRequests).toBe(0);
	});

	it("resets the silent streak on output or a new selector and ignores non-timeout failures", () => {
		const budget = new RecoveryBudget({ maxSilentTimeouts: 2 });
		const silent = { silentTimeout: true, progressed: false, selector: "a/m" };
		budget.recordAttemptOutcome(silent);
		budget.recordAttemptOutcome({ silentTimeout: false, progressed: false, selector: "a/m" });
		expect(budget.snapshot().silentTimeouts).toBe(1);
		budget.recordAttemptOutcome({ silentTimeout: true, progressed: true, selector: "a/m" });
		expect(budget.snapshot().silentTimeouts).toBe(0);
		budget.recordAttemptOutcome(silent);
		budget.recordAttemptOutcome({ ...silent, selector: "b/m" });
		expect(budget.snapshot().silentTimeouts).toBe(1);
		expect(budget.canAdmit()).toBe(true);
		expect(() => new RecoveryBudget({ maxSilentTimeouts: 0 })).toThrow(
			"maxSilentTimeouts must be a positive integer",
		);
	});

	it("starts the fifteen-minute window at the first recoverable failure and rejects its exact deadline", () => {
		let now = 10_000;
		const budget = new RecoveryBudget({ now: () => now });
		budget.reserve("inference");
		now = 50_000;
		budget.recordRecoverableFailure();
		now = 51_000;
		budget.recordRecoverableFailure();

		now = 50_000 + SAME_MODEL_RECOVERY_WINDOW_MS - 1;
		expect(budget.reserve("inference").requestNumber).toBe(2);
		now += 1;
		expect(budget.canAdmit()).toBe(false);
		expect(rejection(() => budget.reserve("inference"))).toBe("deadline");
		expect(budget.snapshot().deadlineAtMs).toBe(50_000 + SAME_MODEL_RECOVERY_WINDOW_MS);
	});

	it("fails closed after cancellation and rejects invalid limits", () => {
		const budget = new RecoveryBudget();
		budget.cancel();

		expect(rejection(() => budget.reserve("inference"))).toBe("cancelled");
		expect(() => new RecoveryBudget({ maxRequests: 0 })).toThrow("maxRequests must be a positive integer");
		expect(() => new RecoveryBudget({ windowMs: Number.POSITIVE_INFINITY })).toThrow(
			"windowMs must be a positive integer",
		);
	});
});

describe("createUpstreamAdmission", () => {
	it("spends nothing on local construction and charges every concrete fetch", async () => {
		const kinds: RecoveryRequestKind[] = [];
		const sent: string[] = [];
		const base: FetchImpl = async input => {
			sent.push(String(input));
			return new Response("ok");
		};
		const admission = createUpstreamAdmission(kind => kinds.push(kind), base);
		expect(kinds).toEqual([]);

		await admission.fetch("https://example.test/first");
		await admission.fetch("https://example.test/resend");
		admission.onUpstreamRequest("token");

		expect(kinds).toEqual(["inference", "resend", "token"]);
		expect(sent).toEqual(["https://example.test/first", "https://example.test/resend"]);
	});

	it("rejects a refused request before it reaches the network", async () => {
		const budget = new RecoveryBudget({ maxRequests: 2 });
		let sent = 0;
		const base: FetchImpl = async () => {
			sent += 1;
			return new Response("ok");
		};
		const admission = createUpstreamAdmission(kind => budget.reserve(kind), base);
		await admission.fetch("https://example.test/a");
		await admission.fetch("https://example.test/b");
		const refused = await admission.fetch("https://example.test/c").then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(sent).toBe(2);
		expect(refused).toBeInstanceOf(RecoveryAdmissionError);
		expect(isRecoveryAdmissionErrorMessage((refused as Error).message)).toBe(true);
		expect(isRecoveryAdmissionErrorMessage("rate limit exceeded")).toBe(false);
	});

	it("refuses outbound, not local construction, when the owner has no capacity", () => {
		const budget = new RecoveryBudget({ maxRequests: 1 });
		budget.reserve("inference");
		const admission = createUpstreamAdmission(kind => budget.reserve(kind), undefined);
		expect(() => admission.onUpstreamRequest("inference")).toThrow(RecoveryAdmissionError);
	});
	it("rechecks cancellation on the very first wire after local preparation", async () => {
		let sent = 0;
		const budget = new RecoveryBudget();
		const admission = createUpstreamAdmission(
			kind => budget.reserve(kind),
			async () => {
				sent++;
				return new Response("ok");
			},
			() => budget.assertActive(),
		);
		budget.cancel();
		await expect(admission.fetch("https://example.test/first")).rejects.toThrow(
			"Recovery was cancelled before another upstream request",
		);
		expect(sent).toBe(0);
		expect(budget.snapshot().usedRequests).toBe(0);
	});

	it("starts the recovery deadline at an inner HTTP transient response", async () => {
		let now = 100;
		const budget = new RecoveryBudget({ windowMs: 50, now: () => now });
		const admission = createUpstreamAdmission(
			kind => budget.reserve(kind),
			async () => new Response("unavailable", { status: 503 }),
			() => budget.assertActive(),
			() => budget.recordRecoverableFailure(),
		);
		await admission.fetch("https://example.test/first");
		expect(budget.snapshot().firstFailureAtMs).toBe(100);
		now = 150;
		await expect(admission.fetch("https://example.test/resend")).rejects.toThrow("Recovery time limit reached");
		expect(budget.snapshot().usedRequests).toBe(1);
	});
});

describe("RecoveryBudget.canAdmitAfter", () => {
	it("refuses a wait that would cross the recovery deadline", () => {
		let now = 1_000;
		const budget = new RecoveryBudget({ windowMs: 10_000, now: () => now });
		expect(budget.canAdmitAfter(60_000)).toBe(true);
		budget.recordRecoverableFailure();
		expect(budget.canAdmitAfter(9_999)).toBe(true);
		expect(budget.canAdmitAfter(10_000)).toBe(false);
		now += 5_000;
		expect(budget.canAdmitAfter(4_999)).toBe(true);
		expect(budget.canAdmitAfter(5_000)).toBe(false);
	});
});

describe("RecoveryBudget monotonic deadline", () => {
	it("does not extend a recovery window when the wall clock moves backwards", () => {
		let monotonic = 100;
		const perf = spyOn(performance, "now").mockImplementation(() => monotonic);
		const wall = spyOn(Date, "now").mockReturnValue(9_999_999);
		try {
			const budget = new RecoveryBudget({ windowMs: 50 });
			budget.reserve("inference");
			budget.recordRecoverableFailure();
			wall.mockReturnValue(1);
			monotonic = 150;
			expect(rejection(() => budget.reserve("resend"))).toBe("deadline");
			expect(budget.snapshot().deadlineAtMs).toBe(150);
		} finally {
			perf.mockRestore();
			wall.mockRestore();
		}
	});
});
