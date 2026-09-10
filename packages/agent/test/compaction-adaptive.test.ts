import { describe, expect, test } from "bun:test";
import { type AdaptiveCompactionOptions, AdaptiveCompactionTracker } from "@sayknow-cli/agent-core/compaction/adaptive";
import type { CompactionSettings } from "@sayknow-cli/agent-core/compaction/compaction";
import {
	computeAdaptiveThresholdPercent,
	DEFAULT_COMPACTION_SETTINGS,
	resolveThresholdTokens,
	shouldCompact,
} from "@sayknow-cli/agent-core/compaction/compaction";

const CONTEXT_WINDOW = 200_000;

function options(overrides: Partial<AdaptiveCompactionOptions> = {}): AdaptiveCompactionOptions {
	return { enabled: true, turnWindow: 15, baseThresholdPercent: 85, aggression: 0.15, ...overrides };
}

/** Busy enough to saturate `intensity`, and past the post-compaction grace. */
function busyState(): { turnsSinceCompact: number; callsInWindow: number } {
	return { turnsSinceCompact: 40, callsInWindow: 1_000 };
}

describe("computeAdaptiveThresholdPercent", () => {
	test("returns the base untouched when adaptive mode is disabled", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW * 0.9,
			CONTEXT_WINDOW,
			busyState(),
			options({ enabled: false, aggression: 1 }),
		);
		expect(percent).toBe(85);
	});

	test("returns the base while the context is far below it", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW * 0.2,
			CONTEXT_WINDOW,
			busyState(),
			options({ aggression: 1 }),
		);
		expect(percent).toBe(85);
	});

	test("returns the base during the post-compaction grace", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW * 0.9,
			CONTEXT_WINDOW,
			{ turnsSinceCompact: 3, callsInWindow: 1_000 },
			options({ aggression: 1 }),
		);
		expect(percent).toBe(85);
	});

	test("lowers the threshold once the session is busy and near the base", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW * 0.9,
			CONTEXT_WINDOW,
			busyState(),
			options({ aggression: 1, minThresholdPercent: 50 }),
		);
		expect(percent).toBe(50);
	});

	test("aggression scales how far the threshold moves", () => {
		const shared = [85, CONTEXT_WINDOW * 0.9, CONTEXT_WINDOW, busyState()] as const;
		const gentle = computeAdaptiveThresholdPercent(...shared, options({ aggression: 0.15 }));
		const strong = computeAdaptiveThresholdPercent(...shared, options({ aggression: 1 }));
		expect(gentle).toBeLessThan(85);
		expect(strong).toBeLessThan(gentle);
	});

	test("aggression 0 leaves the base in place even at full intensity", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW * 0.9,
			CONTEXT_WINDOW,
			busyState(),
			options({ aggression: 0 }),
		);
		expect(percent).toBe(85);
	});

	test("never goes below the configured floor", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW,
			CONTEXT_WINDOW,
			busyState(),
			options({ aggression: 1, minThresholdPercent: 70 }),
		);
		expect(percent).toBe(70);
	});

	test("a floor above the base cannot raise the threshold", () => {
		const percent = computeAdaptiveThresholdPercent(
			85,
			CONTEXT_WINDOW,
			CONTEXT_WINDOW,
			busyState(),
			options({ aggression: 1, minThresholdPercent: 95 }),
		);
		expect(percent).toBe(85);
	});

	test("a missing state or unusable window falls back to the base", () => {
		expect(
			computeAdaptiveThresholdPercent(85, CONTEXT_WINDOW, CONTEXT_WINDOW, undefined, options({ aggression: 1 })),
		).toBe(85);
		expect(computeAdaptiveThresholdPercent(85, CONTEXT_WINDOW, 0, busyState(), options({ aggression: 1 }))).toBe(85);
		expect(
			computeAdaptiveThresholdPercent(
				85,
				CONTEXT_WINDOW,
				CONTEXT_WINDOW,
				busyState(),
				options({ aggression: 1, turnWindow: 0 }),
			),
		).toBe(85);
	});
});

describe("resolveThresholdTokens with adaptive settings", () => {
	function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
		return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
	}

	test("a fixed token limit still wins over adaptive", () => {
		const tokens = resolveThresholdTokens(
			CONTEXT_WINDOW,
			settings({
				thresholdTokens: 50_000,
				thresholdPercent: 85,
				adaptive: options({ aggression: 1 }),
				adaptiveState: busyState(),
			}),
			0,
			CONTEXT_WINDOW * 0.9,
		);
		expect(tokens).toBe(50_000);
	});

	test("disabled adaptive preserves the configured percentage exactly", () => {
		const fixed = resolveThresholdTokens(CONTEXT_WINDOW, settings({ thresholdPercent: 85 }), 0, CONTEXT_WINDOW * 0.9);
		const withDisabled = resolveThresholdTokens(
			CONTEXT_WINDOW,
			settings({
				thresholdPercent: 85,
				adaptive: options({ enabled: false, aggression: 1 }),
				adaptiveState: busyState(),
			}),
			0,
			CONTEXT_WINDOW * 0.9,
		);
		expect(withDisabled).toBe(fixed);
		expect(fixed).toBe(Math.floor(CONTEXT_WINDOW * 0.85));
	});

	test("absent adaptive settings preserve the reserve-based default path", () => {
		const before = resolveThresholdTokens(CONTEXT_WINDOW, settings({ thresholdPercent: -1 }), 0);
		const after = resolveThresholdTokens(CONTEXT_WINDOW, settings({ thresholdPercent: -1 }), 0, CONTEXT_WINDOW * 0.9);
		expect(after).toBe(before);
	});

	test("enabled adaptive lowers the threshold for a busy session", () => {
		const fixed = resolveThresholdTokens(CONTEXT_WINDOW, settings({ thresholdPercent: 85 }), 0, CONTEXT_WINDOW * 0.9);
		const adaptive = resolveThresholdTokens(
			CONTEXT_WINDOW,
			settings({
				thresholdPercent: 85,
				adaptive: options({ aggression: 1, minThresholdPercent: 50 }),
				adaptiveState: busyState(),
			}),
			0,
			CONTEXT_WINDOW * 0.9,
		);
		expect(adaptive).toBeLessThan(fixed);
		expect(adaptive).toBe(Math.floor(CONTEXT_WINDOW * 0.5));
	});

	test("adaptive supplies its own base when no percentage is configured", () => {
		const tokens = resolveThresholdTokens(
			CONTEXT_WINDOW,
			settings({
				thresholdPercent: -1,
				adaptive: options({ baseThresholdPercent: 80, aggression: 0 }),
				adaptiveState: busyState(),
			}),
			0,
			CONTEXT_WINDOW * 0.9,
		);
		expect(tokens).toBe(Math.floor(CONTEXT_WINDOW * 0.8));
	});
});

describe("shouldCompact with adaptive settings", () => {
	test("a busy session compacts at a fill the fixed threshold would allow", () => {
		const contextTokens = Math.floor(CONTEXT_WINDOW * 0.7);
		const base: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 85 };

		expect(shouldCompact(contextTokens, CONTEXT_WINDOW, base)).toBe(false);
		expect(
			shouldCompact(contextTokens, CONTEXT_WINDOW, {
				...base,
				adaptive: options({ aggression: 1, minThresholdPercent: 50 }),
				adaptiveState: busyState(),
			}),
		).toBe(true);
	});

	test("adaptive cannot make a disabled or off strategy compact", () => {
		const contextTokens = CONTEXT_WINDOW;
		const adaptive = {
			adaptive: options({ aggression: 1 }),
			adaptiveState: busyState(),
		};
		expect(
			shouldCompact(contextTokens, CONTEXT_WINDOW, {
				...DEFAULT_COMPACTION_SETTINGS,
				enabled: false,
				...adaptive,
			}),
		).toBe(false);
		expect(
			shouldCompact(contextTokens, CONTEXT_WINDOW, {
				...DEFAULT_COMPACTION_SETTINGS,
				strategy: "off",
				...adaptive,
			}),
		).toBe(false);
	});
});

describe("AdaptiveCompactionTracker", () => {
	test("counts calls and turns since the last compaction", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(10, 1_000);
		tracker.recordCall(20, 2_000);

		expect(tracker.decisionState()).toEqual({ turnsSinceCompact: 2, callsInWindow: 2, lastContextTokens: 20 });
	});

	test("rolls the call window once the span elapses", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(10, 1_000);
		tracker.recordCall(10, 2_000);
		tracker.recordCall(10, 61_000);

		const state = tracker.decisionState();
		expect(state.callsInWindow).toBe(1);
		expect(state.turnsSinceCompact).toBe(3);
	});

	test("a compaction clears the rate and the turn count", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(10, 1_000);
		tracker.recordCall(10, 2_000);
		tracker.recordCompact(5, 3_000);

		expect(tracker.decisionState()).toEqual({ turnsSinceCompact: 0, callsInWindow: 0, lastContextTokens: 5 });
		expect(tracker.snapshot().lastCompactTs).toBe(3_000);
	});

	test("resizing the window restarts the count so a rate is never carried across spans", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(10, 1_000);
		tracker.recordCall(10, 2_000);
		tracker.setWindowMs(120_000, 3_000);

		expect(tracker.windowMs).toBe(120_000);
		expect(tracker.decisionState().callsInWindow).toBe(0);
		// Turn count is independent of the window and must survive a resize.
		expect(tracker.decisionState().turnsSinceCompact).toBe(2);
	});

	test("an unchanged window is not a reset", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(10, 1_000);
		tracker.setWindowMs(60_000, 2_000);

		expect(tracker.decisionState().callsInWindow).toBe(1);
	});

	test("non-finite context tokens are normalized to zero", () => {
		const tracker = new AdaptiveCompactionTracker(60_000, 0);
		tracker.recordCall(Number.NaN, 1_000);
		expect(tracker.decisionState().lastContextTokens).toBe(0);
	});
});
