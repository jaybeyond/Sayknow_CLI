import { describe, expect, it } from "bun:test";
import type { Message } from "@sayknow-cli/ai";
import { serializeConversation } from "../src/compaction/utils";

function assistantWithToolCall(args: unknown): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: args as Record<string, unknown> }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as Message;
}

describe("serializeConversation - malformed tool-call arguments", () => {
	it.each([
		{ label: "null", args: null },
		{ label: "undefined", args: undefined },
		{ label: "string", args: "malformed" },
		{ label: "number", args: 42 },
		{ label: "boolean", args: false },
		{ label: "array", args: ["malformed"] },
	])("does not throw when arguments is $label", ({ args }) => {
		const serialized = serializeConversation([assistantWithToolCall(args)]);
		expect(serialized).toContain("bash()");
	});

	it("still serializes well-formed arguments", () => {
		const serialized = serializeConversation([assistantWithToolCall({ command: "ls" })]);
		expect(serialized).toContain('bash(command="ls")');
	});

	it("preserves surrounding valid calls", () => {
		const serialized = serializeConversation([
			assistantWithToolCall({ command: "ls" }),
			assistantWithToolCall(null),
			assistantWithToolCall({ command: "pwd" }),
		]);
		expect(serialized).toContain('bash(command="ls")');
		expect(serialized).toContain("bash()");
		expect(serialized).toContain('bash(command="pwd")');
	});
});
