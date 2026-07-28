import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { bizrouterModelManagerOptions } from "../src/provider-models/openai-compat";
import { getEnvApiKey } from "../src/stream";
import { getOAuthProviders } from "../src/utils/oauth";

const originalBizRouterApiKey = Bun.env.BIZROUTER_API_KEY;
const originalFetch = global.fetch;

function bizRouterResponse(models: unknown[]): Response {
	return new Response(JSON.stringify({ models }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	if (originalBizRouterApiKey === undefined) {
		delete Bun.env.BIZROUTER_API_KEY;
	} else {
		Bun.env.BIZROUTER_API_KEY = originalBizRouterApiKey;
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("bizrouter provider support", () => {
	test("resolves BIZROUTER_API_KEY from environment", () => {
		const ambient = Bun.env.BIZROUTER_API_KEY;
		if (ambient) {
			// A key inherited from the launching shell resolves through the credential env.
			expect(getEnvApiKey("bizrouter")).toBe(ambient);
		} else {
			Bun.env.BIZROUTER_API_KEY = "sk-br-v1-test";
			expect(getEnvApiKey("bizrouter")).toBe("sk-br-v1-test");
		}
	});

	test("registers built-in descriptor and default model", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "bizrouter");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("anthropic/claude-sonnet-4.5");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("BIZROUTER_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.bizrouter).toBe("anthropic/claude-sonnet-4.5");
	});

	test("registers BizRouter in OAuth provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "bizrouter");
		expect(provider?.name).toBe("BizRouter");
	});

	test("discovers and maps models from the BizRouter envelope", async () => {
		global.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								id: "anthropic/claude-sonnet-4.5",
								slug: "anthropic/claude-sonnet-4.5",
								name: "Anthropic: Claude Sonnet 4.5",
								display_name: "Anthropic Claude Sonnet 4.5 (BizRouter)",
								context_length: 200000,
								max_output_tokens: 64000,
								input_price_per_1m_usd: 3,
								output_price_per_1m_usd: 15,
								input_price_per_1m_krw: 4593,
								output_price_per_1m_krw: 22965,
								input_modalities: ["text", "image"],
								output_modalities: ["text"],
							},
							{
								id: "openai/gpt-4o",
								slug: "openai/gpt-4o",
								name: "OpenAI: GPT-4o",
								display_name: "OpenAI: GPT-4o",
								context_length: 128000,
								max_output_tokens: 16384,
								input_price_per_1m_usd: 2.5,
								output_price_per_1m_usd: 10,
								input_price_per_1m_krw: 3827.5,
								output_price_per_1m_krw: 15310,
								input_modalities: ["text"],
								output_modalities: ["text"],
							},
						],
						exchange_rate: 1531,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const options = bizrouterModelManagerOptions({ apiKey: "sk-br-v1-test" });
		expect(options.providerId).toBe("bizrouter");
		expect(options.fetchDynamicModels).toBeDefined();

		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.bizrouter.ai/v1/models",
			expect.objectContaining({ method: "GET" }),
		);

		const anthropic = models?.find(model => model.id === "anthropic/claude-sonnet-4.5");
		expect(anthropic?.api).toBe("openai-completions");
		expect(anthropic?.baseUrl).toBe("https://api.bizrouter.ai/v1");
		expect(anthropic?.provider).toBe("bizrouter");
		expect(anthropic?.contextWindow).toBe(200000);
		expect(anthropic?.maxTokens).toBe(64000);
		expect(anthropic?.cost.input).toBe(3);
		expect(anthropic?.cost.output).toBe(15);
		expect(anthropic?.name).toBe("Anthropic Claude Sonnet 4.5 (BizRouter)");
		expect(anthropic?.cost.cacheRead).toBe(0.3);
		expect(anthropic?.cost.cacheWrite).toBe(3.75);
		expect(anthropic?.input).toEqual(["text", "image"]);

		const openai = models?.find(model => model.id === "openai/gpt-4o");
		expect(openai?.input).toEqual(["text"]);
	});

	test("falls back to bundled prices for invalid BizRouter prices", async () => {
		const invalidPrices: Array<Record<string, unknown>> = [
			{ input_price_per_1m_usd: null, output_price_per_1m_usd: "not-a-number" },
			{ input_price_per_1m_usd: undefined, output_price_per_1m_usd: null },
			{ input_price_per_1m_usd: "not-a-number", output_price_per_1m_usd: undefined },
		];

		for (const prices of invalidPrices) {
			global.fetch = vi.fn(async () =>
				bizRouterResponse([
					{
						id: "anthropic/claude-sonnet-4.5",
						name: "Claude Sonnet 4.5",
						...prices,
					},
				]),
			) as unknown as typeof fetch;

			const models = await bizrouterModelManagerOptions({ apiKey: "sk-br-v1-test" }).fetchDynamicModels?.();
			const anthropic = models?.find(model => model.id === "anthropic/claude-sonnet-4.5");
			expect(anthropic?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		}
	});

	test("falls back to bundled prices for negative BizRouter prices", async () => {
		global.fetch = vi.fn(async () =>
			bizRouterResponse([
				{
					id: "anthropic/claude-sonnet-4.5",
					name: "Claude Sonnet 4.5",
					input_price_per_1m_usd: -2.5,
					output_price_per_1m_usd: -7.5,
				},
			]),
		) as unknown as typeof fetch;

		const models = await bizrouterModelManagerOptions({ apiKey: "sk-br-v1-test" }).fetchDynamicModels?.();
		const anthropic = models?.find(model => model.id === "anthropic/claude-sonnet-4.5");
		expect(anthropic?.cost.input).toBe(3);
		expect(anthropic?.cost.output).toBe(15);
	});

	test("preserves legitimate zero BizRouter prices", async () => {
		global.fetch = vi.fn(async () =>
			bizRouterResponse([
				{
					id: "anthropic/claude-sonnet-4.5",
					name: "Claude Sonnet 4.5",
					input_price_per_1m_usd: 0,
					output_price_per_1m_usd: 0,
				},
			]),
		) as unknown as typeof fetch;

		const models = await bizrouterModelManagerOptions({ apiKey: "sk-br-v1-test" }).fetchDynamicModels?.();
		const anthropic = models?.find(model => model.id === "anthropic/claude-sonnet-4.5");
		expect(anthropic?.cost.input).toBe(0);
		expect(anthropic?.cost.output).toBe(0);
	});

	test("skips dynamic discovery without an API key", () => {
		const options = bizrouterModelManagerOptions();
		expect(options.providerId).toBe("bizrouter");
		expect(options.fetchDynamicModels).toBeUndefined();
	});
});
