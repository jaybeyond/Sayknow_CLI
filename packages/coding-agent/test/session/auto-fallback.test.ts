import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@sayknow-cli/ai";
import { defaultModelPerProvider } from "../../src/config/model-resolver";
import { AUTO_FALLBACK_PROVIDER_LIMIT, autoFallbackSelectors, selectorProvider } from "../../src/session/auto-fallback";

const model = (key: string): Model<Api> => {
	const [provider, id] = key.split("/") as [string, string];
	return { provider, id } as Model<Api>;
};
const curated = (provider: keyof typeof defaultModelPerProvider): string =>
	`${provider}/${defaultModelPerProvider[provider]}`;

describe("selectorProvider", () => {
	it("reads the provider of a qualified selector and nothing from an alias", () => {
		expect(selectorProvider("anthropic/claude-opus-5-5:high")).toBe("anthropic");
		expect(selectorProvider("best-coder")).toBeUndefined();
		expect(selectorProvider("/weird")).toBeUndefined();
	});
});

describe("autoFallbackSelectors", () => {
	const loggedIn = new Set(["anthropic", "openai", "google", "zai"]);
	const hasCredentials = (provider: string) => loggedIn.has(provider);

	it("takes one model per other logged-in provider: most recently used, else the curated default", () => {
		const available = [
			model(curated("openai")),
			model("openai/gpt-4o-mini"),
			model(curated("google")),
			model(curated("anthropic")),
		];
		const selectors = autoFallbackSelectors({
			available,
			hasCredentials,
			excludeProviders: new Set(["anthropic"]),
			usageOrder: ["openai/gpt-4o-mini"],
		});
		expect(selectors).toEqual(["openai/gpt-4o-mini", curated("google")]);
	});

	it("puts providers used recently first, then curated-default order", () => {
		const available = [model(curated("openai")), model(curated("google")), model(curated("zai"))];
		const selectors = autoFallbackSelectors({
			available,
			hasCredentials,
			excludeProviders: new Set(),
			usageOrder: [curated("zai")],
		});
		expect(selectors[0]).toBe(curated("zai"));
		expect(new Set(selectors)).toEqual(new Set([curated("zai"), curated("openai"), curated("google")]));
	});

	it("skips providers without credentials, excluded providers, and providers with nothing known to pick", () => {
		const available = [
			model(curated("openai")),
			// Logged in, but neither used before nor its curated default: not guessed.
			model("google/gemini-1.0-ancient"),
			// Keyless/local provider: available, but not a logged-in account.
			model("ollama/llama3"),
		];
		const selectors = autoFallbackSelectors({
			available,
			hasCredentials,
			excludeProviders: new Set(["openai"]),
			usageOrder: [],
		});
		expect(selectors).toEqual([]);
	});

	it("ignores usage entries that are no longer available", () => {
		const selectors = autoFallbackSelectors({
			available: [model(curated("openai"))],
			hasCredentials,
			excludeProviders: new Set(),
			usageOrder: ["openai/removed-model"],
		});
		expect(selectors).toEqual([curated("openai")]);
	});

	it("stops at the provider limit", () => {
		const providers = ["openai", "google", "zai", "anthropic"] as const;
		const selectors = autoFallbackSelectors({
			available: providers.map(provider => model(curated(provider))),
			hasCredentials,
			excludeProviders: new Set(),
		});
		expect(selectors).toHaveLength(AUTO_FALLBACK_PROVIDER_LIMIT);
		expect(autoFallbackSelectors({ available: [], hasCredentials, excludeProviders: new Set(), limit: 0 })).toEqual(
			[],
		);
	});
});
