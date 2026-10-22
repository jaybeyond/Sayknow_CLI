import { describe, expect, it } from "bun:test";
import { calculateCost, getBundledModel } from "../src/models";
import type { Usage } from "../src/types";

describe("calculateCost", () => {
	it("keeps token-based calculation for GitHub Copilot models", () => {
		const model = {
			...getBundledModel("github-copilot", "gpt-4o"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 123,
				output: 456,
				cacheRead: 789,
				cacheWrite: 321,
				total: 1689,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("keeps token-based calculation for non-Copilot providers", () => {
		const model = {
			...getBundledModel("openai", "gpt-4o-mini"),
			cost: {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 800,
			},
		};
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};

		calculateCost(model, usage);

		expect(usage.cost.input).toBeCloseTo(1, 8);
		expect(usage.cost.output).toBeCloseTo(1, 8);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 8);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.08, 8);
		expect(usage.cost.total).toBeCloseTo(2.18, 8);
	});

	it("prices OpenAI Codex GPT models from the matching OpenAI catalog entry", () => {
		const openAIModel = getBundledModel("openai", "gpt-5.4");
		const codexModel = getBundledModel("openai-codex", "gpt-5.4");
		const usage: Usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		expect(codexModel.cost).toEqual(openAIModel.cost);

		calculateCost(codexModel, usage);

		expect(usage.cost.total).toBeCloseTo(0.01005, 8);
	});

	it("bundles and calculates Cursor Composer pricing", () => {
		const expectedPricing = [
			{ id: "composer-2.5", cost: { input: 0.5, output: 2.5, cacheRead: 0, cacheWrite: 0 }, total: 0.00175 },
			{ id: "composer-2.5-fast", cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, total: 0.0105 },
		] as const;

		for (const expected of expectedPricing) {
			const model = getBundledModel("cursor", expected.id);
			const usage: Usage = {
				input: 1_000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(model.cost).toEqual(expected.cost);
			calculateCost(model, usage);
			expect(usage.cost.total).toBeCloseTo(expected.total, 8);
		}
	});
});
