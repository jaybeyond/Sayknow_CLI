/**
 * Typed decisions — entry point.
 *
 * Call sites ask for a judgment and get a typed answer or nothing. They never learn
 * which backend answered, and they never have to handle a transport error: every
 * failure path resolves `null`. That is deliberate — a decision service is an
 * *enhancement* to code that already works, so an outage must degrade behaviour to
 * the previous default rather than break the turn.
 */
import { logger } from "@sayknow-cli/utils";
import { createLlmDecisionBackend, type LlmBackendDeps } from "./llm-backend";
import type { DecisionBackend, DecisionRequest, DecisionResult } from "./types";
import { createTypeSafeDecisionBackend } from "./typesafe-backend";

export { createLlmDecisionBackend } from "./llm-backend";
export * from "./types";
export { createTypeSafeDecisionBackend, TYPESAFE_PROVIDER } from "./typesafe-backend";

/** Hard ceiling. A decision that takes longer than this is worthless to the caller. */
const DEFAULT_TIMEOUT_MS = 8_000;

export interface DecisionServiceOptions extends LlmBackendDeps {
	/** Off by default; callers opt in per feature. */
	enabled?: boolean;
	timeoutMs?: number;
	/** Injection point for tests and for the self-hosted/hosted backends. */
	backends?: DecisionBackend[];
}

export interface DecisionService {
	readonly enabled: boolean;
	/** Resolves null when disabled, unavailable, timed out, or the model misbehaved. */
	decide(request: DecisionRequest): Promise<DecisionResult | null>;
}

export function createDecisionService(options: DecisionServiceOptions): DecisionService {
	const enabled = options.enabled ?? false;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	/**
	 * Order matters and is not configurable by accident.
	 *
	 * TypeSafe first *when a key exists*: it is the only backend that returns calibrated
	 * probabilities, and it resolves `null` immediately when no key is stored, so users
	 * who never added one pay nothing for it being in the list.
	 *
	 * The user's logged-in provider is the fallback and the default experience: no extra
	 * vendor, no extra key, works offline of TypeSafe entirely. Inside it, a live local
	 * runtime is tried before a hosted small model; see `llm-backend.ts`.
	 */
	const backends = options.backends ?? [createTypeSafeDecisionBackend(options), createLlmDecisionBackend(options)];

	return {
		enabled,
		async decide(request: DecisionRequest): Promise<DecisionResult | null> {
			if (!enabled || backends.length === 0) return null;
			for (const backend of backends) {
				// A listener added to a signal that already fired never runs, and the
				// backends only read their own derived signal. Measured: a caller that
				// aborted during the previous backend's await got a full attempt budget of
				// silence from the next one instead of an immediate null.
				if (request.signal?.aborted) return null;
				const controller = new AbortController();
				const abortOnCallerSignal = () => controller.abort();
				request.signal?.addEventListener("abort", abortOnCallerSignal, { once: true });
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					// The deadline must be a race, not just an abort. A provider that ignores
					// its signal would otherwise hang the caller's turn forever — and the
					// caller here is the user's prompt, so "forever" means a frozen session.
					const deadline = new Promise<null>(resolve => {
						timer = setTimeout(() => {
							controller.abort();
							resolve(null);
						}, timeoutMs);
					});
					const result = await Promise.race([backend.decide({ ...request, signal: controller.signal }), deadline]);
					if (result) return result;
				} catch (error) {
					// Fail open: log and try the next backend, then give up quietly.
					logger.debug("decisions: backend failed", { backend: backend.name, error: String(error) });
				} finally {
					if (timer) clearTimeout(timer);
					controller.abort();
					request.signal?.removeEventListener("abort", abortOnCallerSignal);
				}
			}
			return null;
		},
	};
}
