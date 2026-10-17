import { describe, expect, it } from "bun:test";
import { convertBedrockMessages } from "../src/providers/amazon-bedrock";
import type { AssistantMessage, Model, UserMessage } from "../src/types";

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	return {
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		id,
		name: id,
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
	};
}

function replay(model: Model<"bedrock-converse-stream">, content: AssistantMessage["content"]) {
	const user: UserMessage = { role: "user", content: "continue", timestamp: 0 };
	const assistant: AssistantMessage = {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	return convertBedrockMessages({ messages: [user, assistant] }, model, "none").find(
		message => message.role === "assistant",
	)?.content;
}

describe("Bedrock thinking replay", () => {
	const claude = bedrockModel("us.anthropic.claude-sonnet-4-6");

	it("replays signed Claude reasoning natively", () => {
		expect(
			replay(claude, [
				{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig" },
				{ type: "text", text: "answer" },
			]),
		).toEqual([
			{ reasoningContent: { reasoningText: { text: "signed reasoning", signature: "sig" } } },
			{ text: "answer" },
		]);
	});

	it("drops unsigned Claude reasoning instead of demoting it to visible text", () => {
		const content = replay(claude, [
			{ type: "thinking", thinking: "unsigned reasoning" },
			{ type: "text", text: "answer" },
		]);
		expect(content).toEqual([{ text: "answer" }]);
		expect(JSON.stringify(content)).not.toContain("unsigned reasoning");
	});

	it("keeps unsigned reasoning for models without signature support", () => {
		expect(
			replay(bedrockModel("deepseek.r1-v1:0"), [
				{ type: "thinking", thinking: "native reasoning" },
				{ type: "text", text: "answer" },
			]),
		).toEqual([{ reasoningContent: { reasoningText: { text: "native reasoning" } } }, { text: "answer" }]);
	});
});
