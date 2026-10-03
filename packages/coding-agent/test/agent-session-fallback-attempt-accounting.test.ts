import { describe, expect, it } from "bun:test";
import { classifyFallbackTrigger } from "@sayknow-cli/ai";
import {
	type ConfiguredFallbackChain,
	cappedExponentialWithFullJitter,
	effectiveFallbackDelay,
	FallbackChainController,
} from "@sayknow-cli/coding-agent/session/fallback-chain-controller";

function chain(entries: string[]): ConfiguredFallbackChain {
	return { role: "default", entries, origin: "model_selection", explicitHead: true };
}

describe("FallbackChainController attempt accounting", () => {
	it("exhausted quota switches models immediately", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 3);
		expect(controller.currentSelector()).toBe("a/1");
		expect(controller.onAttemptFailure("quota", "out_of_credits")).toBe("advance");
		expect(controller.currentSelector()).toBe("b/2");
		expect(controller.attemptsUsed).toBe(0);
	});

	it("transient failures retry the same model and then stop without switching", () => {
		for (const triggerClass of ["server", "rate_limit", "unknown"] as const) {
			const controller = new FallbackChainController(chain(["a/1", "b/2"]), 3);
			expect(controller.onAttemptFailure(triggerClass, "transient")).toBe("retry"); // attempt 1
			expect(controller.onAttemptFailure(triggerClass, "transient")).toBe("retry"); // attempt 2
			expect(controller.currentSelector()).toBe("a/1");
			expect(controller.onAttemptFailure(triggerClass, "transient")).toBe("stop"); // attempt 3
			// Never switched, never exhausted: the next request reuses the same model.
			expect(controller.currentSelector()).toBe("a/1");
			expect(controller.isExhausted()).toBe(false);
			expect(controller.attemptsUsed).toBe(0);
		}
	});

	it("auth failures switch models only after the same-model budget", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 2);
		expect(controller.onAttemptFailure("auth", "401")).toBe("retry");
		expect(controller.onAttemptFailure("auth", "401")).toBe("advance");
		expect(controller.currentSelector()).toBe("b/2");
	});

	it("exhausts the chain when every entry is out of quota", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 2);
		expect(controller.onAttemptFailure("quota", "quota")).toBe("advance");
		expect(controller.onAttemptFailure("quota", "quota")).toBe("exhausted");
		expect(controller.isExhausted()).toBe(true);
		expect(controller.currentSelector()).toBeUndefined();
	});

	it("resolution-time skips consume zero attempts", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2", "c/3"]), 3);
		expect(controller.onResolutionSkip("unauthenticated")).toBe(true);
		expect(controller.currentSelector()).toBe("b/2");
		expect(controller.attemptsUsed).toBe(0);
		expect(controller.tried).toHaveLength(0);
		expect(controller.skips).toEqual([{ selector: "a/1", reason: "unauthenticated" }]);
	});

	it("resets a tail-model controller to the head for the next fresh user turn", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 2);
		controller.onAttemptFailure("quota", "quota");
		expect(controller.currentSelector()).toBe("b/2");
		controller.resetForNewTurn();
		expect(controller.currentSelector()).toBe("a/1");
		expect(controller.attemptsUsed).toBe(0);
		expect(controller.tried).toHaveLength(0);
		expect(controller.isExhausted()).toBe(false);
	});

	it("gives the sticky active entry a fresh request budget after accepted requests", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 3);
		controller.onAttemptStarted();
		controller.resetAttemptBudget(); // first accepted request
		controller.onAttemptStarted();
		controller.resetAttemptBudget(); // second accepted request
		expect(controller.onAttemptFailure("server", "500")).toBe("retry");
		expect(controller.attemptsUsed).toBe(1);
		expect(controller.currentSelector()).toBe("a/1");
	});

	it("refreshes the bounded credential-rotation retry after an accepted request", () => {
		const controller = new FallbackChainController(chain(["a/1", "b/2"]), 1);
		expect(controller.onAttemptFailure("quota", "credential A")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		controller.resetAttemptBudget();

		expect(controller.onAttemptFailure("quota", "credential B")).toBe("advance");
		expect(controller.restorePreviousEntryForRetry()).toBe(true);
		expect(controller.currentSelector()).toBe("a/1");
	});

	it("rejects a non-positive maxAttempts", () => {
		expect(() => new FallbackChainController(chain(["a/1"]), 0)).toThrow(/positive integer/);
	});

	it("an empty chain is exhausted from construction", () => {
		const controller = new FallbackChainController(chain([]), 3);
		expect(controller.isExhausted()).toBe(true);
		expect(controller.onAttemptFailure("server", "500")).toBe("exhausted");
	});
});

describe("effective fallback delay precedence", () => {
	it("uses capped exponential full jitter when no Retry-After is present", () => {
		// random() = 1 -> full jitter returns the whole capped window.
		expect(cappedExponentialWithFullJitter(100, 10_000, 1, () => 1)).toBe(100);
		expect(cappedExponentialWithFullJitter(100, 10_000, 3, () => 1)).toBe(400);
		// Cap applies.
		expect(cappedExponentialWithFullJitter(100, 250, 5, () => 1)).toBe(250);
	});

	it("full jitter scales the window by random()", () => {
		expect(cappedExponentialWithFullJitter(100, 10_000, 3, () => 0)).toBe(0);
		expect(cappedExponentialWithFullJitter(100, 10_000, 3, () => 0.5)).toBe(200);
	});

	it("Retry-After wins when larger and is never capped by maxDelayMs", () => {
		// Retry-After (60s) far exceeds the capped exponential window (<=250ms).
		expect(effectiveFallbackDelay(100, 250, 2, 60_000, () => 1)).toBe(60_000);
	});

	it("jittered delay wins when it exceeds Retry-After", () => {
		expect(effectiveFallbackDelay(1_000, 10_000, 3, 100, () => 1)).toBe(4_000);
	});
});

describe("structured fallback transport facts", () => {
	it("classifies a generic-message 401 as an auth fallback trigger", () => {
		expect(classifyFallbackTrigger({ message: "provider returned error", status: 401 }).class).toBe("auth");
	});
});

describe("per-subagent-call stickiness", () => {
	it("a fresh controller for the same role/chain starts at the head, unaffected by a prior call's fallback", () => {
		// Each subagent invocation builds its own memory-only controller from the
		// same configured chain intent (see task/executor.ts setConfiguredModelChain).
		const configured = chain(["a/1", "b/2", "c/3"]);

		// Subagent 1 falls back to c/3 during its lifecycle (both heads out of quota).
		const call1 = new FallbackChainController(configured, 1);
		expect(call1.onAttemptFailure("quota", "quota")).toBe("advance");
		expect(call1.onAttemptFailure("quota", "quota")).toBe("advance");
		expect(call1.currentSelector()).toBe("c/3");

		// Subagent 2 (same role) gets a brand-new controller: starts at the head.
		const call2 = new FallbackChainController(configured, 1);
		expect(call2.currentSelector()).toBe("a/1");
		expect(call2.attemptsUsed).toBe(0);
		expect(call2.tried).toHaveLength(0);

		// The two controllers do not share sticky state.
		expect(call1.currentSelector()).toBe("c/3");
	});
});
