import type { Api, Model } from "@sayknow-cli/ai";
import { defaultModelPerProvider } from "../config/model-resolver";

/**
 * How many other providers the automatic tail may add. Each entry can cost up to
 * `fallback.maxAttempts` tries before the chain moves on, so the tail stays short.
 */
export const AUTO_FALLBACK_PROVIDER_LIMIT = 3;

/** Provider of a `provider/model[:level]` selector, or undefined for bare aliases. */
export function selectorProvider(selector: string): string | undefined {
	const slash = selector.indexOf("/");
	return slash > 0 ? selector.slice(0, slash) : undefined;
}

export interface AutoFallbackInput {
	/** Models whose provider has auth configured (`ModelRegistry.getAvailable()`). */
	available: readonly Model<Api>[];
	/** True when the provider has a stored credential or API key (keyless local providers do not count). */
	hasCredentials: (provider: string) => boolean;
	/** Providers already in the chain; the tail adds a different provider or nothing. */
	excludeProviders: ReadonlySet<string>;
	/** Most-recently-used `provider/id` keys, newest first. */
	usageOrder?: readonly string[];
	limit?: number;
}

/**
 * One model per other logged-in provider, for the automatic tail of the default
 * fallback chain. Within a provider the model the user used most recently wins,
 * then the provider's curated default; a provider with neither is skipped rather
 * than guessed, because catalog order would land on an old model. Providers used
 * recently come first, then the rest in curated-default order.
 */
export function autoFallbackSelectors(input: AutoFallbackInput): string[] {
	const limit = input.limit ?? AUTO_FALLBACK_PROVIDER_LIMIT;
	if (limit <= 0) return [];
	const availableKeys = new Set(input.available.map(model => `${model.provider}/${model.id}`));
	const picked = new Map<string, { selector: string; rank: number }>();
	const eligible = (provider: string): boolean =>
		!picked.has(provider) && !input.excludeProviders.has(provider) && input.hasCredentials(provider);

	const usageOrder = input.usageOrder ?? [];
	usageOrder.forEach((key, index) => {
		const provider = selectorProvider(key);
		if (!provider || !availableKeys.has(key) || !eligible(provider)) return;
		picked.set(provider, { selector: key, rank: index });
	});
	Object.entries(defaultModelPerProvider).forEach(([provider, modelId], index) => {
		const key = `${provider}/${modelId}`;
		if (!availableKeys.has(key) || !eligible(provider)) return;
		picked.set(provider, { selector: key, rank: usageOrder.length + index });
	});

	return [...picked.values()]
		.sort((left, right) => left.rank - right.rank)
		.slice(0, limit)
		.map(entry => entry.selector);
}
