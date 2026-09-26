import { describe, expect, it } from "bun:test";
import { injectCodexGpt6Models, injectImageGenerationModels } from "../scripts/generate-models";
import type { Model } from "../src/types";

describe("injectCodexGpt6Models", () => {
	it("adds each reviewed GPT-6 Codex fallback exactly once", () => {
		const models: Model[] = [];

		injectCodexGpt6Models(models);
		injectCodexGpt6Models(models);

		const shared = {
			api: "openai-codex-responses",
			provider: "openai-codex",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272_000,
			maxTokens: 128_000,
			preferWebsockets: true,
		};
		expect(models).toEqual([
			expect.objectContaining({ ...shared, id: "gpt-6-astra", name: "GPT-6-Astra", priority: 1 }),
			expect.objectContaining({ ...shared, id: "gpt-6-sol", name: "GPT-6-Sol" }),
			expect.objectContaining({ ...shared, id: "gpt-6-luna", name: "GPT-6-Luna" }),
		]);
		// Only the flagship is promoted; Sol and Luna keep default catalog order.
		expect(models.filter(model => model.priority !== undefined).map(model => model.id)).toEqual(["gpt-6-astra"]);
	});

	it("records the published standard pricing so discovered zero-cost rows are not billed as free", () => {
		const models: Model[] = [];
		injectCodexGpt6Models(models);

		const costOf = (id: string) => models.find(model => model.id === id)?.cost;
		expect(costOf("gpt-6-astra")).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(costOf("gpt-6-sol")).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
		expect(costOf("gpt-6-luna")).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
	});

	it("preserves authenticated discovery metadata", () => {
		const discovered: Model<"openai-codex-responses"> = {
			id: "gpt-6-sol",
			name: "Newer discovery name",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 300_000,
			maxTokens: 128_000,
		};
		const models: Model[] = [discovered];

		injectCodexGpt6Models(models);

		expect(models.filter(model => model.id === "gpt-6-sol")).toEqual([discovered]);
		expect(models.map(model => model.id)).toEqual(["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"]);
	});
});
describe("injectImageGenerationModels", () => {
	it("adds typed image-output models once for OpenAI and Codex", () => {
		const models: Model[] = [];

		injectImageGenerationModels(models);
		injectImageGenerationModels(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-responses",
				provider: "openai",
				input: ["text"],
				output: ["text", "image"],
			}),
			expect.objectContaining({
				id: "gpt-image-2",
				api: "openai-codex-responses",
				provider: "openai-codex",
				input: ["text"],
				output: ["text", "image"],
			}),
		]);
	});
});
