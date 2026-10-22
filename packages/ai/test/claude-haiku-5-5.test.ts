import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@sayknow-cli/ai";
import {
	Effort,
	enrichModelThinking,
	hasAnthropicModelSamplingRestrictions,
	mapEffortToAnthropicAdaptiveEffort,
	requiresAnthropicThinkingDisableWhenOff,
} from "@sayknow-cli/ai/model-thinking";
import { streamBedrock } from "@sayknow-cli/ai/providers/amazon-bedrock";
import { streamAnthropic } from "@sayknow-cli/ai/providers/anthropic";
import type { Api, Context, Model, Provider } from "@sayknow-cli/ai/types";

function createModel<TApi extends Api>(id: string, api: TApi, provider: Provider): Model<TApi> {
	return enrichModelThinking({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const context: Context = {
	systemPrompt: ["You are concise."],
	messages: [{ role: "user", content: "ping", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Looks up an answer.",
			parameters: { type: "object", properties: {} } as never,
		},
	],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type AnthropicPayload = {
	thinking?: { type?: string; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
	top_p?: number;
	tool_choice?: unknown;
};

function captureAnthropic(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2],
): Promise<AnthropicPayload> {
	const { promise, resolve } = Promise.withResolvers<AnthropicPayload>();
	void streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as AnthropicPayload);
			return undefined;
		},
	});
	return promise;
}

type BedrockPayload = {
	additionalModelRequestFields?: {
		thinking?: { type?: string; display?: string };
		output_config?: { effort?: string };
	};
};

function captureBedrock(
	model: Model<"bedrock-converse-stream">,
	options: Parameters<typeof streamBedrock>[2],
): Promise<BedrockPayload> {
	const { promise, resolve } = Promise.withResolvers<BedrockPayload>();
	void streamBedrock(model, context, {
		signal: abortedSignal(),
		...options,
		onPayload: payload => {
			resolve(payload as BedrockPayload);
			return undefined;
		},
	});
	return promise;
}

const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
beforeAll(() => {
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
});
afterAll(() => {
	if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
});

describe("Claude Haiku 5.5 (gajae #6872, #6874)", () => {
	it("resolves Haiku 5.x as adaptive with a medium default while Haiku 4.5 keeps the generic ladder", () => {
		const haiku55 = createModel("claude-haiku-5-5", "anthropic-messages", "anthropic");
		const haiku45 = createModel("claude-haiku-4-5", "anthropic-messages", "anthropic");

		expect(haiku55.thinking).toEqual({
			mode: "anthropic-adaptive",
			minLevel: Effort.Low,
			maxLevel: Effort.Max,
			defaultLevel: Effort.Medium,
		});
		expect(haiku45.thinking?.mode).toBe("budget");
		expect(haiku45.thinking?.defaultLevel).toBeUndefined();
		expect(mapEffortToAnthropicAdaptiveEffort(haiku55, Effort.XHigh)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(haiku55, Effort.Max)).toBe("max");
	});

	it("applies the same efforts and medium default to Bedrock Haiku 5.5 selectors", () => {
		for (const id of ["anthropic.claude-haiku-5-5", "us.anthropic.claude-haiku-5-5"]) {
			const model = createModel(id, "bedrock-converse-stream", "amazon-bedrock");
			expect(model.thinking).toEqual({
				mode: "anthropic-adaptive",
				minLevel: Effort.Low,
				maxLevel: Effort.Max,
				defaultLevel: Effort.Medium,
			});
		}
	});

	it("ships bundled direct and Bedrock rows that resolve to the adaptive policy", () => {
		expect(getBundledModel("anthropic", "claude-haiku-5-5").thinking?.mode).toBe("anthropic-adaptive");
		expect(getBundledModel("anthropic", "claude-sonnet-5-5").thinking?.mode).toBe("anthropic-adaptive");
		expect(getBundledModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5").thinking?.maxLevel).toBe(
			Effort.Max,
		);
	});

	it("limits the Haiku predicates to generation 5", () => {
		expect(requiresAnthropicThinkingDisableWhenOff("claude-haiku-5-5")).toBe(true);
		expect(requiresAnthropicThinkingDisableWhenOff("claude-haiku-4-5")).toBe(false);
		expect(requiresAnthropicThinkingDisableWhenOff("claude-opus-5-5")).toBe(false);
		expect(hasAnthropicModelSamplingRestrictions("claude-haiku-5-5")).toBe(true);
		expect(hasAnthropicModelSamplingRestrictions("claude-opus-4-7")).toBe(true);
		expect(hasAnthropicModelSamplingRestrictions("claude-sonnet-4-5")).toBe(false);
	});

	it("sends an explicit disabled thinking block when Off and strips sampling controls", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5") as Model<"anthropic-messages">;
		const payload = await captureAnthropic(model, { thinkingEnabled: false, temperature: 0.4, topP: 0.9 });
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
	});

	it("requests summarized adaptive thinking when On", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5") as Model<"anthropic-messages">;
		const payload = await captureAnthropic(model, { thinkingEnabled: true, reasoning: Effort.High });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it.each([
		[Effort.Medium, "medium"],
		[Effort.High, "high"],
		[Effort.XHigh, "high"],
		[Effort.Max, "high"],
	] as const)("keeps effort %s (capped at high) with disabled thinking on forced tool choice", async (reasoning, expected) => {
		const model = getBundledModel("anthropic", "claude-haiku-5-5") as Model<"anthropic-messages">;
		const payload = await captureAnthropic(model, {
			thinkingEnabled: true,
			reasoning,
			toolChoice: { type: "tool", name: "lookup" },
		});
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBe(expected);
	});

	it("still drops thinking entirely on forced tool choice for other adaptive models", async () => {
		const model = getBundledModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">;
		const payload = await captureAnthropic(model, {
			thinkingEnabled: true,
			reasoning: Effort.High,
			toolChoice: { type: "tool", name: "lookup" },
		});
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("sends disabled thinking on Bedrock when reasoning is off, and keeps capped effort on forced tool choice", async () => {
		const model = getBundledModel(
			"amazon-bedrock",
			"us.anthropic.claude-haiku-5-5",
		) as Model<"bedrock-converse-stream">;
		const off = await captureBedrock(model, {});
		expect(off.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" } });

		const forced = await captureBedrock(model, {
			reasoning: Effort.Max,
			toolChoice: { type: "tool", name: "lookup" },
		});
		expect(forced.additionalModelRequestFields?.thinking).toEqual({ type: "disabled" });
		expect(forced.additionalModelRequestFields?.output_config?.effort).toBe("high");
	});
});

describe("Gemini 4 Argon and GPT-6.1 Sol catalog (gajae #6731, af1dc0f)", () => {
	it("resolves Gemini 4 Argon to google-level thinking with low/medium/high and a 65,536 output cap", () => {
		const argon = getBundledModel("google", "gemini-4-argon");
		expect(argon.thinking).toMatchObject({ mode: "google-level", minLevel: Effort.Low, maxLevel: Effort.High });
		expect(argon.maxTokens).toBeLessThanOrEqual(65_536);
		const aliased = enrichModelThinking({
			...createModel("gemini-4-argon", "google-generative-ai", "google"),
			maxTokens: 200_000,
		});
		expect(aliased.thinking?.mode).toBe("google-level");
	});

	it("keeps Gemini 3.x on google-level and pre-3 on budget thinking", () => {
		expect(createModel("gemini-3-pro", "google-generative-ai", "google").thinking?.mode).toBe("google-level");
		expect(createModel("gemini-2.5-pro", "google-generative-ai", "google").thinking?.mode).toBe("budget");
	});

	it("ships GPT-6.1 Sol on the codex transport with the same contract as GPT-6 Sol", () => {
		const sol61 = getBundledModel("openai-codex", "gpt-6.1-sol");
		const sol6 = getBundledModel("openai-codex", "gpt-6-sol");
		expect(sol61.contextWindow).toBe(sol6.contextWindow);
		expect(sol61.maxTokens).toBe(sol6.maxTokens);
		expect(sol61.thinking).toEqual(sol6.thinking);
	});
});
