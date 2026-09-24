/**
 * Decision backend backed by TypeSafe's hosted System One model (`jev`).
 *
 * Unlike the LLM backend, this one returns **calibrated probabilities**: the model is
 * trained to make the number mean what it says, so `confidence` is a value code can
 * threshold on rather than a ranking. That is the whole reason to prefer it when a key
 * is present — the type safety alone we already get from enum-constrained tool calls.
 *
 * Credentials ride the existing store (`ModelRegistry.getApiKeyForProvider`), so a key
 * added through the normal "add model" flow turns this backend on and removing it turns
 * it off. There is nothing extra to configure.
 *
 * Deliberately *not* registered in `packages/ai`'s provider registry: that registry is
 * for streaming chat APIs, and this endpoint has no stream, no messages, and no text
 * output. Wiring it there would force a `Model` shape onto something that is not a chat
 * model. It stays a plain HTTP client behind the `DecisionBackend` interface.
 */
import { logger } from "@sayknow-cli/utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	type Answer,
	type DecisionBackend,
	type DecisionRequest,
	type DecisionResult,
	type Question,
	validateQuestions,
} from "./types";

/** Provider id under which the key is stored and surfaced in the model list. */
export const TYPESAFE_PROVIDER = "typesafe";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
/** The hosted model answers in well under a second; anything slower is a network fault. */
const REQUEST_TIMEOUT_MS = 10_000;

interface TypeSafeAnswer {
	type?: string;
	noul?: number;
	choice?: string;
	score?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
	confidence?: number;
}

interface TypeSafeResponse {
	model?: string;
	answers?: Record<string, TypeSafeAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Our question shape is already the System One shape, so this is a rename rather than a
 * translation — `noul` carries no criteria, `choice` an id→meaning map, `score` an
 * ordered level array. Keeping them aligned is what lets a caller switch backends
 * without touching the call site.
 */
function toWireQuestions(questions: Record<string, Question>): Record<string, unknown> {
	const wire: Record<string, unknown> = {};
	for (const [key, question] of Object.entries(questions)) {
		wire[key] =
			question.type === "noul"
				? { type: "noul", instructions: question.instructions }
				: { type: question.type, instructions: question.instructions, criteria: question.criteria };
	}
	return wire;
}

/**
 * Map a wire answer onto our typed answer.
 *
 * Anything that does not match the question we asked is dropped rather than coerced: a
 * decision that looks typed but is not the one we requested is worse than a missing one,
 * because the caller cannot tell the difference.
 */
function toAnswer(question: Question, raw: TypeSafeAnswer | undefined): Answer | null {
	if (!raw) return null;
	if (question.type === "noul") {
		return typeof raw.noul === "number" ? { type: "noul", noul: raw.noul } : null;
	}
	if (question.type === "choice") {
		if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) return null;
		return {
			type: "choice",
			choice: raw.choice,
			...(raw.probabilities ? { probabilities: raw.probabilities } : {}),
			...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
		};
	}
	if (typeof raw.score !== "number") return null;
	const level = Math.min(question.criteria.length - 1, Math.max(0, Math.round(raw.score)));
	return {
		type: "score",
		score: raw.score,
		level,
		legend: raw.legend ?? Object.fromEntries(question.criteria.map((meaning, index) => [String(index), meaning])),
		...(raw.probabilities ? { probabilities: raw.probabilities } : {}),
		...(typeof raw.confidence === "number" ? { confidence: raw.confidence } : {}),
	};
}

export interface TypeSafeBackendDeps {
	registry: ModelRegistry;
	sessionId?: string;
	/** Override for self-hosted or proxied deployments. */
	baseUrl?: string;
	/** Model id sent in the request body. Named to avoid colliding with the LLM backend's `model`. */
	modelId?: string;
	/** Injected in tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

export function createTypeSafeDecisionBackend(deps: TypeSafeBackendDeps): DecisionBackend {
	const baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const model = deps.modelId ?? DEFAULT_MODEL;
	const doFetch = deps.fetchImpl ?? fetch;

	return {
		name: "typesafe",
		async decide(request: DecisionRequest): Promise<DecisionResult | null> {
			validateQuestions(request.questions);
			const apiKey = await deps.registry.getApiKeyForProvider(TYPESAFE_PROVIDER, deps.sessionId);
			// No key means the user never added TypeSafe. That is not an error — the next
			// backend (their logged-in model) handles it.
			if (!apiKey) return null;
			// The credential lookup awaited; a caller that aborted meanwhile must not start
			// a request whose abort listener would never fire.
			if (request.signal?.aborted) return null;

			const controller = new AbortController();
			const abortOnCaller = () => controller.abort();
			request.signal?.addEventListener("abort", abortOnCaller, { once: true });
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const started = Date.now();
			try {
				const response = await doFetch(`${baseUrl}/v1/systemone`, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ state: request.state, model, questions: toWireQuestions(request.questions) }),
					signal: controller.signal,
				});
				if (!response.ok) {
					logger.debug("decisions/typesafe: request failed", {
						status: response.status,
						body: (await response.text().catch(() => "")).slice(0, 300),
					});
					return null;
				}
				const payload = (await response.json()) as TypeSafeResponse;
				const answers: Record<string, Answer> = {};
				for (const [key, question] of Object.entries(request.questions)) {
					const answer = toAnswer(question, payload.answers?.[key]);
					if (answer) answers[key] = answer;
				}
				if (Object.keys(answers).length === 0) return null;
				return {
					answers,
					backend: "typesafe",
					model: payload.model ?? model,
					// The hosted System One model is trained for calibration; this is the one
					// backend allowed to claim it.
					calibrated: true,
					durationMs: Date.now() - started,
				};
			} finally {
				clearTimeout(timer);
				request.signal?.removeEventListener("abort", abortOnCaller);
			}
		},
	};
}
