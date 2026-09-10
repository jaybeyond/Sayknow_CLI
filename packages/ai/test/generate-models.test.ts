import { describe, expect, it } from "bun:test";
import { injectCodexAstraModel, injectImageGenerationModels } from "../scripts/generate-models";
import type { Model } from "../src/types";

describe("injectCodexAstraModel", () => {
	it("adds the reviewed Codex fallback exactly once", () => {
		const models: Model[] = [];

		injectCodexAstraModel(models);
		injectCodexAstraModel(models);

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-6-astra",
				name: "GPT-6-Astra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 272_000,
				maxTokens: 128_000,
				preferWebsockets: true,
				priority: 1,
			}),
		]);
	});

	it("preserves authenticated discovery metadata", () => {
		const discovered: Model<"openai-codex-responses"> = {
			id: "gpt-6-astra",
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

		injectCodexAstraModel(models);

		expect(models).toEqual([discovered]);
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
