/**
 * Adaptive compaction state.
 *
 * A fixed threshold compacts at the same context percentage regardless of how
 * fast the session is filling the window. During a tool-call burst the context
 * can jump well past the threshold between two checks, while a slow session
 * compacts more often than it needs to. The tracker records call rate per
 * window so {@link ../compaction!computeAdaptiveThresholdPercent} can lower the
 * threshold while a session is busy and leave it alone otherwise.
 *
 * Opt-in: with `compaction.adaptive.enabled` false the tracker is still cheap to
 * run but its state never reaches a threshold decision.
 */

export interface AdaptiveCompactionState {
	turnsSinceCompact: number;
	callsInWindow: number;
	windowStart: number;
	lastContextTokens: number;
	lastCompactContextTokens: number | null;
	lastCompactTs: number | null;
}

/** The subset a threshold decision reads; keeps the decision path pure. */
export interface AdaptiveCompactionDecisionState {
	turnsSinceCompact: number;
	callsInWindow: number;
	lastContextTokens?: number;
}

export interface AdaptiveCompactionOptions {
	enabled: boolean;
	/** Minutes of recent calls considered when measuring call rate. */
	turnWindow: number;
	/** Context percentage used when the session is not busy. */
	baseThresholdPercent: number;
	/** How strongly call rate lowers the threshold, 0 to 1. */
	aggression: number;
	/** Lowest percentage the threshold may be lowered to. */
	minThresholdPercent?: number;
}

const DEFAULT_WINDOW_MS = 60_000;

function initialState(now: number): AdaptiveCompactionState {
	return {
		turnsSinceCompact: 0,
		callsInWindow: 0,
		windowStart: now,
		lastContextTokens: 0,
		lastCompactContextTokens: null,
		lastCompactTs: null,
	};
}

export class AdaptiveCompactionTracker {
	#state: AdaptiveCompactionState;
	#windowMs: number;

	constructor(windowMs: number = DEFAULT_WINDOW_MS, now: number = Date.now()) {
		this.#windowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
		this.#state = initialState(now);
	}

	get windowMs(): number {
		return this.#windowMs;
	}

	/** Changing the window restarts the current count so a resize cannot inherit a rate measured over a different span. */
	setWindowMs(windowMs: number, now: number = Date.now()): void {
		if (!Number.isFinite(windowMs)) return;
		const nextWindowMs = Math.max(1, windowMs);
		if (nextWindowMs === this.#windowMs) return;
		this.#windowMs = nextWindowMs;
		this.#state.windowStart = now;
		this.#state.callsInWindow = 0;
	}

	reset(now: number = Date.now()): void {
		this.#state = initialState(now);
	}

	recordCall(contextTokens: number, now: number = Date.now()): void {
		const timestamp = Number.isFinite(now) ? now : Date.now();
		this.#state.turnsSinceCompact += 1;
		if (timestamp - this.#state.windowStart >= this.#windowMs) {
			this.#state.windowStart = timestamp;
			this.#state.callsInWindow = 0;
		}
		this.#state.callsInWindow += 1;
		this.#state.lastContextTokens = Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
	}

	recordCompact(contextTokens: number, now: number = Date.now()): void {
		const timestamp = Number.isFinite(now) ? now : Date.now();
		const safeContextTokens = Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
		this.#state.turnsSinceCompact = 0;
		this.#state.callsInWindow = 0;
		this.#state.windowStart = timestamp;
		this.#state.lastContextTokens = safeContextTokens;
		this.#state.lastCompactContextTokens = safeContextTokens;
		this.#state.lastCompactTs = timestamp;
	}

	snapshot(): AdaptiveCompactionState {
		return { ...this.#state };
	}

	decisionState(): AdaptiveCompactionDecisionState {
		return {
			turnsSinceCompact: this.#state.turnsSinceCompact,
			callsInWindow: this.#state.callsInWindow,
			lastContextTokens: this.#state.lastContextTokens,
		};
	}
}
