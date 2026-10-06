import type { FetchImpl } from "../types";

export const SAME_MODEL_RECOVERY_MAX_REQUESTS = 7;
export const SAME_MODEL_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
/** Full-jitter backoff for default same-model transient recovery; Retry-After is a floor. */
export const SAME_MODEL_RECOVERY_BASE_DELAY_MS = 1000;
export const SAME_MODEL_RECOVERY_MAX_DELAY_MS = 30_000;
/** Consecutive no-output timeouts after which a step stops before spending its full budget. */
export const SAME_MODEL_RECOVERY_MAX_SILENT_TIMEOUTS = 3;

/**
 * `inference` starts a model invocation; `resend` is any further inference request
 * of the same invocation (hidden SDK/stream replay, transport fallback), which only
 * happens after an upstream failure.
 */
export type RecoveryRequestKind = "inference" | "resend" | "token";

export type RecoveryAdmissionRejection = "cancelled" | "request_limit" | "deadline" | "silent_stall";

const RECOVERY_ADMISSION_MESSAGES: Readonly<Record<RecoveryAdmissionRejection, string>> = {
	cancelled: "Recovery was cancelled before another upstream request",
	request_limit: "Recovery request limit reached",
	deadline: "Recovery time limit reached",
	silent_stall: "Recovery stopped after repeated timeouts without any output",
};

/** True for a {@link RecoveryAdmissionError} message; such a failure must never be retried. */
export function isRecoveryAdmissionErrorMessage(message: string | undefined): boolean {
	return message !== undefined && Object.values(RECOVERY_ADMISSION_MESSAGES).includes(message);
}

export class RecoveryAdmissionError extends Error {
	readonly reason: RecoveryAdmissionRejection;

	constructor(reason: RecoveryAdmissionRejection) {
		super(RECOVERY_ADMISSION_MESSAGES[reason]);
		this.name = "RecoveryAdmissionError";
		this.reason = reason;
	}
}

export interface RecoveryBudgetSnapshot {
	readonly usedRequests: number;
	readonly maxRequests: number;
	readonly silentTimeouts: number;
	readonly firstFailureAtMs?: number;
	readonly deadlineAtMs?: number;
}

/** One settled upstream attempt of the step, as observed by its single owner. */
export interface RecoveryAttemptOutcome {
	/** The attempt ended in a first-event or idle timeout. */
	readonly silentTimeout: boolean;
	/** The attempt produced output (text, thinking or tool calls). */
	readonly progressed: boolean;
	/** Provider/model that served the attempt; a different selector starts a new streak. */
	readonly selector: string;
}

export interface RecoveryRequestAdmission {
	readonly kind: RecoveryRequestKind;
	readonly requestNumber: number;
}

export interface RecoveryBudgetOptions {
	maxRequests?: number;
	windowMs?: number;
	/** Consecutive no-output timeouts that close admission (default 3). */
	maxSilentTimeouts?: number;
	now?: () => number;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

/**
 * Owns the concrete upstream request envelope for one unfinished model step.
 * Callers must reserve immediately before each outbound request; there is no
 * method that refunds or recreates capacity.
 */
export class RecoveryBudget {
	readonly #maxRequests: number;
	readonly #windowMs: number;
	readonly #maxSilentTimeouts: number;
	readonly #now: () => number;
	#usedRequests = 0;
	#firstFailureAtMs: number | undefined;
	#cancelled = false;
	#silentTimeouts = 0;
	#silentSelector: string | undefined;

	constructor(options: RecoveryBudgetOptions = {}) {
		this.#maxRequests = positiveInteger(options.maxRequests ?? SAME_MODEL_RECOVERY_MAX_REQUESTS, "maxRequests");
		this.#windowMs = positiveInteger(options.windowMs ?? SAME_MODEL_RECOVERY_WINDOW_MS, "windowMs");
		this.#maxSilentTimeouts = positiveInteger(
			options.maxSilentTimeouts ?? SAME_MODEL_RECOVERY_MAX_SILENT_TIMEOUTS,
			"maxSilentTimeouts",
		);
		this.#now = options.now ?? (() => performance.now());
	}

	/** Checks owner liveness without consuming another request slot. */
	assertActive(): void {
		if (this.#cancelled) throw new RecoveryAdmissionError("cancelled");
		if (this.#firstFailureAtMs !== undefined && this.#now() >= this.#firstFailureAtMs + this.#windowMs) {
			throw new RecoveryAdmissionError("deadline");
		}
		if (this.isSilentStalled()) throw new RecoveryAdmissionError("silent_stall");
	}

	/**
	 * Records one settled attempt. Output resets the streak, a timeout without output
	 * extends it, anything else leaves it unchanged. Returns true when this call
	 * closed admission.
	 */
	recordAttemptOutcome(outcome: RecoveryAttemptOutcome): boolean {
		if (this.#silentSelector !== outcome.selector) {
			this.#silentSelector = outcome.selector;
			this.#silentTimeouts = 0;
		}
		if (outcome.progressed) {
			this.#silentTimeouts = 0;
			return false;
		}
		if (!outcome.silentTimeout || this.isSilentStalled()) return false;
		this.#silentTimeouts += 1;
		return this.isSilentStalled();
	}

	isSilentStalled(): boolean {
		return this.#silentTimeouts >= this.#maxSilentTimeouts;
	}

	reserve(kind: RecoveryRequestKind): RecoveryRequestAdmission {
		this.assertActive();
		if (this.#usedRequests >= this.#maxRequests) throw new RecoveryAdmissionError("request_limit");
		this.#usedRequests += 1;
		return { kind, requestNumber: this.#usedRequests };
	}

	recordRecoverableFailure(): void {
		this.#firstFailureAtMs ??= this.#now();
	}

	cancel(): void {
		this.#cancelled = true;
	}

	canAdmit(): boolean {
		return (
			!this.#cancelled &&
			!this.isSilentStalled() &&
			this.#usedRequests < this.#maxRequests &&
			(this.#firstFailureAtMs === undefined || this.#now() < this.#firstFailureAtMs + this.#windowMs)
		);
	}

	/** Whether a request started after waiting `delayMs` could still be admitted. */
	canAdmitAfter(delayMs: number): boolean {
		return (
			this.canAdmit() &&
			(this.#firstFailureAtMs === undefined || this.#now() + delayMs < this.#firstFailureAtMs + this.#windowMs)
		);
	}

	snapshot(): RecoveryBudgetSnapshot {
		return {
			usedRequests: this.#usedRequests,
			maxRequests: this.#maxRequests,
			silentTimeouts: this.#silentTimeouts,
			...(this.#firstFailureAtMs === undefined
				? {}
				: { firstFailureAtMs: this.#firstFailureAtMs, deadlineAtMs: this.#firstFailureAtMs + this.#windowMs }),
		};
	}
}

export interface UpstreamAdmission {
	/** Admits each non-HTTP upstream request at its concrete send boundary. */
	readonly onUpstreamRequest: (kind: RecoveryRequestKind) => void;
	/** `fetch` that admits every outbound HTTP request through {@link onUpstreamRequest}. */
	readonly fetch: FetchImpl;
	/** Credential/token HTTP shares this owner but never masquerades as inference. */
	readonly credentialFetch: FetchImpl;
}

/**
 * Binds concrete HTTP and transport sends to an immutable owner admission hook.
 * Constructing the adapter spends nothing. Every actual token, inference, resend,
 * or transport fallback request is admitted just before it leaves the client.
 */
export function createUpstreamAdmission(
	hook: (kind: RecoveryRequestKind) => void,
	baseFetch: FetchImpl | undefined,
	validate?: () => void,
	onRecoverableFailure?: () => void,
): UpstreamAdmission {
	let sawInference = false;
	const onUpstreamRequest = (kind: RecoveryRequestKind): void => {
		validate?.();
		hook(kind === "inference" && sawInference ? "resend" : kind);
		if (kind === "inference") sawInference = true;
	};
	const base: FetchImpl = baseFetch ?? globalThis.fetch;
	const fetchWithAdmission = (kind: RecoveryRequestKind): FetchImpl =>
		Object.assign(
			(input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				try {
					init?.signal?.throwIfAborted();
					onUpstreamRequest(kind);
				} catch (error) {
					return Promise.reject(error);
				}
				return base(input, init).then(
					response => {
						if (response.status === 429 || response.status >= 500) onRecoverableFailure?.();
						return response;
					},
					(error: unknown) => {
						// A transport rejection is the first transient failure even if an SDK hides it
						// and resends later; caller/owner aborts are cancellations, not failures.
						if (!init?.signal?.aborted && !(error instanceof RecoveryAdmissionError)) onRecoverableFailure?.();
						throw error;
					},
				);
			},
			base.preconnect ? { preconnect: base.preconnect } : {},
		);
	return { onUpstreamRequest, fetch: fetchWithAdmission("inference"), credentialFetch: fetchWithAdmission("token") };
}
