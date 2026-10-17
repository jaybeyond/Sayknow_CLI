import { describe, expect, it } from "bun:test";
import { transformMessages } from "@sayknow-cli/ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@sayknow-cli/ai/types";

// Issue #5805 (ported from upstream): when a model switch degraded foreign
// reasoning to plain text, a decode-looped paragraph repeated tens of thousands
// of times was re-sent verbatim on every later turn. Foreign reasoning is now
// never replayed, so no size of reasoning can reach another model's request.

const deepseekModel: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "deepseek",
	id: "deepseek-reasoner",
	name: "DeepSeek Reasoner",
	baseUrl: "https://api.deepseek.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

const customOpenAIModel: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "custom-openai",
	id: "custom-reasoning-model",
	name: "Custom Reasoning Model",
	baseUrl: "https://api.custom.example/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user: UserMessage = { role: "user", content: "go", timestamp: Date.now() };

function assistantTurn(
	content: AssistantMessage["content"],
	activeModel: Model<AssistantMessage["api"]>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [...content, { type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "echo hi" } }],
		api: activeModel.api,
		provider: activeModel.provider,
		model: activeModel.id,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function completedAssistant(
	content: AssistantMessage["content"],
	activeModel: Model<AssistantMessage["api"]>,
): AssistantMessage {
	return {
		role: "assistant",
		content: [...content],
		api: activeModel.api,
		provider: activeModel.provider,
		model: activeModel.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "bash",
		content: [{ type: "text", text: "hi" }],
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

function assistantTextBlocks(messages: Message[]): string[] {
	const blocks: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "text") blocks.push(block.text);
		}
	}
	return blocks;
}

describe("transform-messages cross-model reasoning replay (#5805)", () => {
	it("drops foreign reasoning of any size instead of replaying it as assistant text", () => {
		const repeatCount = 65_956;
		const repeatedParagraph = "Need think again";
		const repeatedRun = `${repeatedParagraph}\n\n`.repeat(repeatCount - 1) + repeatedParagraph;
		const reasoning = `Distinct leading thought.\n\n${repeatedRun}\n\nDistinct closing thought.`;
		const finalText = `Visible final answer.\n\n${"This final paragraph is not reasoning.\n\n".repeat(80)}Visible final tail.`;
		const toolContent = `${"Repeated tool output stays untouched.\n\n".repeat(80)}Tool output tail.`;
		const reasoningTurn = completedAssistant(
			[
				{ type: "thinking", thinking: reasoning, thinkingSignature: undefined },
				{ type: "text", text: finalText },
			],
			deepseekModel,
		);
		const toolTurn = assistantTurn(
			[
				{ type: "thinking", thinking: "short foreign reasoning" },
				{ type: "text", text: "Preparing tool call." },
			],
			deepseekModel,
		);
		const toolMessage = { ...toolResult(), content: [{ type: "text" as const, text: toolContent }] };
		const messages: Message[] = [user, reasoningTurn, toolTurn, toolMessage];
		const sourceBefore = JSON.stringify(messages);

		expect(reasoning.length).toBeGreaterThan(1_000_000);

		const transformed = transformMessages(messages, customOpenAIModel);
		expect(assistantTextBlocks(transformed)).toEqual([finalText, "Preparing tool call."]);
		expect(JSON.stringify(transformed)).not.toContain(repeatedParagraph);
		expect(JSON.stringify(transformed)).not.toContain("short foreign reasoning");
		const transformedTool = transformed.find(msg => msg.role === "assistant" && msg.stopReason === "toolUse");
		expect(transformedTool?.role === "assistant" ? transformedTool.content.map(block => block.type) : []).toEqual([
			"text",
			"toolCall",
		]);
		expect(transformed.find(msg => msg.role === "toolResult")).toBe(toolMessage);
		expect(JSON.stringify(messages)).toBe(sourceBefore);

		// The same large reasoning remains native and byte-for-byte unchanged when
		// replayed to its source model.
		const nativeReplay = transformMessages(messages, deepseekModel);
		const nativeAssistant = nativeReplay.find(msg => msg.role === "assistant");
		expect(nativeAssistant?.role).toBe("assistant");
		if (nativeAssistant?.role === "assistant") {
			expect(nativeAssistant.content[0]).toBe(reasoningTurn.content[0]);
		}
	});

	it("drops a foreign reasoning-only turn without inventing visible text", () => {
		const messages: Message[] = [
			user,
			completedAssistant([{ type: "thinking", thinking: "only reasoning" }], deepseekModel),
		];
		const transformed = transformMessages(messages, customOpenAIModel);
		const assistant = transformed.find(msg => msg.role === "assistant");
		expect(assistant?.role === "assistant" ? assistant.content : undefined).toEqual([]);
	});
});
