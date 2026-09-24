// Retired from advertised catalogs because the provider rejects live calls.
//
// google-antigravity/gemini-3.1-pro-high: Cloud Code Assist answers HTTP 400. The
// callable high-thinking path is gemini-3.1-pro-low:high.
//
// anthropic/claude-3-*: the Anthropic API answers 404 `not_found_error` for all three
// (measured 2026-09-23 with a forced tool call). Left in the catalog, the cheapest of
// them ($0.25/MTok) was the first pick for typed decisions, so the "small hosted model"
// fallback silently answered nothing on every registry that had an Anthropic key.
export const RETIRED_MODEL_KEYS = [
	"google-antigravity/gemini-3.1-pro-high",
	"anthropic/claude-3-haiku-20240307",
	"anthropic/claude-3-5-sonnet-20240620",
	"anthropic/claude-3-5-sonnet-20241022",
] as const;

const RETIRED_MODEL_KEY_SET = new Set<string>(RETIRED_MODEL_KEYS);

export function isRetiredModelKey(provider: string, modelId: string): boolean {
	return RETIRED_MODEL_KEY_SET.has(`${provider}/${modelId}`);
}

export function isRetiredModel(model: { provider: string; id: string }): boolean {
	return isRetiredModelKey(model.provider, model.id);
}
