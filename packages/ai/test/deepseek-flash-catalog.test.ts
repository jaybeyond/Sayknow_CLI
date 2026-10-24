import { describe, expect, it } from "bun:test";
import { getBundledModel } from "../src/models";
import { resolveOpenAICompat } from "../src/providers/openai-completions-compat";
import type { Model } from "../src/types";

// DeepSeek renamed its Flash model: `deepseek-flash` is served by DeepSeek-V4.1-Flash-1017, and the
// legacy `deepseek-v4-flash` ids are routed to it. https://api-docs.deepseek.com/quick_start/pricing
describe("DeepSeek V4.1 Flash (deepseek-flash) catalog entry", () => {
	const model = getBundledModel("deepseek", "deepseek-flash") as Model<"openai-completions">;

	it("is bundled for the official DeepSeek provider with vision and a 1M context", () => {
		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.deepseek.com");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBeGreaterThanOrEqual(1_000_000);
	});

	it("carries the same thinking-mode compat as the V4 family", () => {
		const v4Pro = getBundledModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
		expect(model.compat).toEqual(v4Pro.compat);
		expect(model.thinking).toEqual(v4Pro.thinking);

		const compat = resolveOpenAICompat(model);
		expect(compat.extraBody).toEqual({ thinking: { type: "enabled" } });
		expect(compat.reasoningContentField).toBe("reasoning_content");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.supportsToolChoice).toBe(false);
		expect(compat.reasoningEffortMap?.minimal).toBe("high");
	});
});
