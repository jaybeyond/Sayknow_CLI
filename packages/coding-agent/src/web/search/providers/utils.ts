import type { AgentStorage } from "../../../session/agent-storage";
import { SearchProviderError, type SearchProviderId, type SearchSource } from "../../../web/search/types";
import { dateToAgeSeconds } from "../utils";

/**
 * Search for an API credential by checking an env-derived key first,
 * then falling back to agent.db stored credentials for the given providers.
 *
 * The caller MUST supply an open {@link AgentStorage} handle so the helper
 * never reaches out to global filesystem state; both the unified web_search
 * chain and one-shot CLI calls open storage exactly once and thread it
 * through every provider.
 *
 * @param storage - Open agent storage handle
 * @param envKey - Pre-resolved environment variable value (or null)
 * @param storageProviders - Provider names to look up in AgentStorage
 */
export function findCredential(
	storage: AgentStorage | null | undefined,
	envKey: string | null | undefined,
	...storageProviders: string[]
): string | null {
	if (envKey) return envKey;
	if (!storage) return null;

	try {
		for (const provider of storageProviders) {
			const records = storage.listAuthCredentials(provider);
			for (const record of records) {
				const credential = record.credential;
				if (credential.type === "api_key" && credential.key.trim().length > 0) {
					return credential.key;
				}
				if (credential.type === "oauth" && credential.access.trim().length > 0) {
					return credential.access;
				}
			}
		}
	} catch {
		return null;
	}

	return null;
}

/**
 * Legacy hard ceiling for a single web-search round-trip, retained as the
 * fallback for call sites that do not declare a timeout class. 300s tolerates
 * pathological cases while still guaranteeing the session unfreezes if Bun's
 * `AbortSignal` fails to propagate on Windows.
 */
export const SEARCH_HARD_TIMEOUT_MS = 300_000;

/**
 * Hard ceiling for pure search APIs (brave, exa, jina, tavily, kagi,
 * parallel, searxng, synthetic, zai, duckduckgo). These settle in ~1-3s in
 * practice; a hung TCP/TLS connection should fall through to the next
 * provider in seconds, not minutes. Kimi is the exception: it declares an
 * explicit ceiling aligned with its upstream 30s request budget.
 */
export const SEARCH_API_TIMEOUT_MS = 15_000;

/**
 * Hard ceiling for LLM-mediated search providers (anthropic, codex, gemini,
 * perplexity, xai, openai-compatible). These legitimately take tens of
 * seconds because a model performs the search and synthesizes an answer.
 */
export const SEARCH_LLM_TIMEOUT_MS = 120_000;

/** Timeout class a provider declares for its outbound round-trips. */
export type SearchTimeoutClass = "api" | "llm";

const TIMEOUT_CLASS_MS: Record<SearchTimeoutClass, number> = {
	api: SEARCH_API_TIMEOUT_MS,
	llm: SEARCH_LLM_TIMEOUT_MS,
};

/**
 * Runtime-configurable hard timeout, seeded from the `web_search.timeout`
 * setting via {@link setSearchHardTimeoutMs}. When set, it overrides every
 * class default so users keep a single knob. Unset means class defaults apply.
 */
let configuredHardTimeoutMs: number | undefined;

/**
 * Override the hard timeout applied to every web-search round-trip.
 *
 * @param ms - Hard timeout in milliseconds. Non-finite or non-positive
 *   values clear the override so per-class defaults apply.
 */
export function setSearchHardTimeoutMs(ms: number | undefined): void {
	configuredHardTimeoutMs = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Structural settings source for {@link applyConfiguredSearchTimeout}. */
export interface SearchTimeoutSettingSource {
	get(path: "web_search.timeout"): unknown;
	has(path: "web_search.timeout"): boolean;
}

/**
 * Install the `web_search.timeout` override from settings — but only when the
 * user explicitly configured it. The settings schema ships a default value
 * (300), and consuming that default via `get()` alone would reinstall a
 * uniform 300s ceiling on every session, silently disabling the per-class
 * timeout defaults. `has()` distinguishes loaded/overridden settings from
 * schema defaults; unset clears any previous override so class defaults apply.
 */
export function applyConfiguredSearchTimeout(settings: SearchTimeoutSettingSource): void {
	if (!settings.has("web_search.timeout")) {
		setSearchHardTimeoutMs(undefined);
		return;
	}
	const value = settings.get("web_search.timeout");
	setSearchHardTimeoutMs(typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : undefined);
}

/**
 * Compose a caller-supplied {@link AbortSignal} with a hard timeout so an
 * outbound `fetch()` is guaranteed to settle even when the runtime fails to
 * propagate cancellation to the underlying transport.
 *
 * Bun's WinHTTP backend on Windows is known to ignore `AbortSignal` once a
 * TCP/TLS connection stalls (oven-sh/bun#15275, oven-sh/bun#18536); without
 * this safety net a stalled web-search request freezes the entire session
 * because the user's Esc is never delivered to the native layer.
 *
 * @param signal - Caller cancellation signal, if any.
 * @param msOrClass - Explicit timeout in milliseconds, or a
 *   {@link SearchTimeoutClass} resolved to its class default. Omitted falls
 *   back to the legacy {@link SEARCH_HARD_TIMEOUT_MS} ceiling. A user-set
 *   `web_search.timeout` overrides class defaults (but not explicit ms).
 */
export function withHardTimeout(signal: AbortSignal | undefined, msOrClass?: number | SearchTimeoutClass): AbortSignal {
	const ms =
		typeof msOrClass === "number"
			? msOrClass
			: (configuredHardTimeoutMs ?? (msOrClass ? TIMEOUT_CLASS_MS[msOrClass] : SEARCH_HARD_TIMEOUT_MS));
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Map a provider's raw source list to the unified SearchSource shape,
 * clamped to the requested result count and annotated with ageSeconds.
 */
export function toSearchSources(
	sources: ReadonlyArray<{
		title: string;
		url: string;
		snippet?: string;
		publishedDate?: string;
	}>,
	numResults: number,
): SearchSource[] {
	return sources.slice(0, numResults).map(source => ({
		title: source.title,
		url: source.url,
		snippet: source.snippet,
		publishedDate: source.publishedDate,
		ageSeconds: dateToAgeSeconds(source.publishedDate),
	}));
}

/**
 * Quota/auth signals across providers. Telemetry on 15.1.7/15.1.8 showed users
 * hitting credit-exhaustion and 401/402/403 responses that were surfaced as
 * raw HTTP error text. Map those into compact, provider-tagged messages so
 * the orchestrator can chain-advance cleanly and the final summary stays
 * legible when every provider rejects the request.
 *
 * Returns `null` when the response does not match a known quota/auth signal,
 * leaving the caller to throw its provider-specific fallback error.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(
	provider: SearchProviderId,
	status: number,
	body: string,
): SearchProviderError | null {
	if (CREDIT_BODY_PATTERN.test(body)) {
		return new SearchProviderError(provider, `${provider}: credits exhausted`, status);
	}
	if (status === 402) {
		return new SearchProviderError(provider, `${provider}: 402 credits exhausted`, status);
	}
	if (status === 401) {
		return new SearchProviderError(provider, `${provider}: 401 unauthorized`, status);
	}
	if (status === 403) {
		return new SearchProviderError(provider, `${provider}: 403 forbidden`, status);
	}
	return null;
}
