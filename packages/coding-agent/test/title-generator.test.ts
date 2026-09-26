import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@sayknow-cli/agent-core";
import * as ai from "@sayknow-cli/ai";
import { type Api, getBundledModel, type Model } from "@sayknow-cli/ai";
import { prompt } from "@sayknow-cli/utils";
import titleSystemPrompt from "../src/prompts/system/title-system.md" with { type: "text" };
import {
	buildConversationTitleInput,
	formatSessionTerminalTitle,
	generateSessionTitle,
} from "../src/utils/title-generator";

const EXPECTED_TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: 0 } as AgentMessage;
}

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>) {
	return {
		getModelRole(role: string) {
			return role === "default" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("title generator", () => {
	it("returns the title from a forced set_title tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Structured Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		expect(EXPECTED_TITLE_SYSTEM_PROMPT).toContain("conversation digest");
		expect(EXPECTED_TITLE_SYSTEM_PROMPT).toContain("newest substantive message");
		expect(completeSimpleMock.mock.calls[0]?.[1]).toMatchObject({
			systemPrompt: [EXPECTED_TITLE_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: "<user-message>\nInvestigate the resolver\n</user-message>",
				},
			],
			tools: [expect.objectContaining({ name: "set_title" })],
		});
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
	});

	it("falls back to text content when no set_title tool call is returned", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Text Title" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Text Title");
	});

	it("uses a reasoning-safe output budget for reasoning models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Budget Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	it("keeps the newest content from a six-message digest in the generation request", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Latest Task" },
				},
			],
		} as never);
		const latestMarker = "Latest task: preserve the newest digest content";
		const digest = buildConversationTitleInput(
			Array.from({ length: 6 }, (_, index) =>
				user(`${index === 5 ? latestMarker : `Earlier task ${index + 1}`} ${"x".repeat(600)}`),
			),
		);

		expect(digest).toBeDefined();
		expect(digest!.length).toBeLessThanOrEqual(2000);
		expect(digest).toContain(latestMarker);

		const title = await generateSessionTitle(digest!, createRegistry(model), createSettings(model));

		expect(title).toBe("Latest Task");
		expect(completeSimpleMock.mock.calls[0]?.[1]).toMatchObject({
			systemPrompt: [EXPECTED_TITLE_SYSTEM_PROMPT],
			messages: [
				{
					role: "user",
					content: expect.stringContaining(latestMarker),
				},
			],
		});
	});
});

describe("formatSessionTerminalTitle", () => {
	it("returns SKC when no session name or cwd is provided", () => {
		expect(formatSessionTerminalTitle(undefined)).toBe("SKC");
	});

	it("prefixes the session name with SKC", () => {
		expect(formatSessionTerminalTitle("My Session")).toBe("SKC: My Session");
	});

	it("falls back to the cwd basename when no session name is provided", () => {
		expect(formatSessionTerminalTitle(undefined, "/home/user/sayknow")).toBe("SKC: sayknow");
	});

	it("strips control characters from the session name", () => {
		expect(formatSessionTerminalTitle("ab\u0001\u001bc")).toBe("SKC: abc");
	});

	it("falls back to SKC when the sanitized session name is empty", () => {
		expect(formatSessionTerminalTitle("\u0001\u001b")).toBe("SKC");
	});
});
