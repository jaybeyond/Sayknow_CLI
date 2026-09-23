import { describe, expect, test } from "bun:test";
import { Effort } from "../src/model-thinking";
import { getBundledModel } from "../src/models";

describe("preset catalog model entries", () => {
	test("bundles xai/grok-4.7 with vision and supported reasoning levels", () => {
		const model = getBundledModel("xai", "grok-4.7");

		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.x.ai/v1");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(500_000);
		expect(model.maxTokens).toBe(500_000);
		expect(model.cost).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
		expect(model.thinking).toEqual({
			mode: "effort",
			minLevel: Effort.Low,
			maxLevel: Effort.XHigh,
			defaultLevel: Effort.High,
		});
	});
	test("bundles anthropic/claude-opus-5-5 with vision and adaptive thinking", () => {
		const model = getBundledModel("anthropic", "claude-opus-5-5");

		expect(model.id).toBe("claude-opus-5-5");
		expect(model.provider).toBe("anthropic");
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.anthropic.com");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
		expect(model.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Minimal,
			maxLevel: Effort.Max,
		});
	});
	test("bundles kimi-code/kimi-k2.7-code", () => {
		const model = getBundledModel("kimi-code", "kimi-k2.7-code");

		expect(model.id).toBe("kimi-k2.7-code");
		expect(model.provider).toBe("kimi-code");
		expect(model.name).toBe("Kimi K2.7 Code");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});

	test("bundles zai/glm-5.3 flagship", () => {
		const model = getBundledModel("zai", "glm-5.3");

		expect(model.id).toBe("glm-5.3");
		expect(model.provider).toBe("zai");
		expect(model.name).toBe("GLM-5.3");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("text");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(131_072);
		expect(model.thinking).toEqual({ mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.XHigh });
	});

	test("bundles google-gemini-cli/gemini-3.5-flash", () => {
		const model = getBundledModel("google-gemini-cli", "gemini-3.5-flash");

		expect(model.id).toBe("gemini-3.5-flash");
		expect(model.provider).toBe("google-gemini-cli");
		expect(model.api).toBe("google-gemini-cli");
		expect(model.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
		expect(model.name).toBe("Gemini 3.5 Flash");
		expect(model.reasoning).toBe(true);
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.thinking).toEqual({ mode: "google-level", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});

	test("bundles minimax-code/minimax-v3", () => {
		const model = getBundledModel("minimax-code", "minimax-v3");

		expect(model.id).toBe("minimax-v3");
		expect(model.provider).toBe("minimax-code");
		expect(model.name).toBe("MiniMax-V3");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(512_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.thinking).toEqual({ mode: "effort", minLevel: Effort.Minimal, maxLevel: Effort.High });
	});
});
