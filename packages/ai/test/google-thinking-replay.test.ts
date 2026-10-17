import { describe, expect, it } from "bun:test";
import { convertMessages } from "@sayknow-cli/ai/providers/google-shared";
import type { AssistantMessage, Model, UserMessage } from "@sayknow-cli/ai/types";

const gemini: Model<"google-generative-ai"> = {
	api: "google-generative-ai",
	provider: "google",
	id: "gemini-2.5-pro",
	name: "Gemini 2.5 Pro",
	baseUrl: "https://generativelanguage.googleapis.com",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
};

function assistant(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "prior reasoning", thinkingSignature: "c2lnbmF0dXJl" },
			{ type: "text", text: "visible answer" },
		],
		api: "google-generative-ai",
		provider,
		model: modelId,
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
}

const user: UserMessage = { role: "user", content: "continue", timestamp: 0 };

function modelParts(message: AssistantMessage) {
	return convertMessages(gemini, { messages: [user, message] }).find(content => content.role === "model")?.parts;
}

describe("Google thinking replay", () => {
	it("replays the producing model's reasoning as a thought part", () => {
		expect(modelParts(assistant("google", "gemini-2.5-pro"))).toEqual([
			{ thought: true, text: "prior reasoning", thoughtSignature: "c2lnbmF0dXJl" },
			{ text: "visible answer" },
		]);
	});

	it("drops another model's reasoning instead of replaying it as visible text", () => {
		const parts = modelParts(assistant("google", "gemini-2.5-flash"));
		expect(JSON.stringify(parts)).not.toContain("prior reasoning");
		expect(parts?.map(part => part.text)).toEqual(["visible answer"]);
	});
});
