import { describe, expect, it } from "bun:test";
import { agentLoop } from "@sayknow-cli/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@sayknow-cli/agent-core/types";
import type { Message } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import * as z from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("agentLoop: truncated tool-call guard", () => {
	it("rejects a tool call flagged incompleteArguments without executing it", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string(), content: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "write_file",
			label: "Write",
			description: "Write a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};

		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					// Provider flagged the arguments as truncated (hit max output tokens).
					content: [
						{
							type: "toolCall",
							id: "tc-1",
							name: "write_file",
							arguments: { path: "a.ts" }, // best-effort partial parse (missing `content`)
							incompleteArguments: true,
						},
					],
					stopReason: "length",
				},
				{ content: ["recovered"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };

		const toolResults: Array<{ isError?: boolean; text: string }> = [];
		const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);
		for await (const event of stream) {
			if (event.type === "tool_execution_end") {
				const first = event.result.content?.[0];
				toolResults.push({ isError: event.isError, text: first?.type === "text" ? first.text : "" });
			}
		}

		// The tool must never have run on the truncated input.
		expect(executed).toHaveLength(0);

		// Exactly one (error) tool result, with an actionable truncation message.
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].isError).toBe(true);
		expect(toolResults[0].text).toContain("cut off");
		expect(toolResults[0].text).toContain("output token limit");
		expect(toolResults[0].text.toLowerCase()).toContain("re-issue");
	});

	// Ported from upstream gajae 6271dfc8a9 (#6728): only a length stop proves the
	// output-token limit, so any other incomplete call must not blame it.
	for (const stopReason of ["toolUse", "stop"] as const) {
		it(`rejects an incomplete call under stopReason ${stopReason} without blaming the output token limit`, async () => {
			const executed: Array<Record<string, unknown>> = [];
			const toolSchema = z.object({ path: z.string(), content: z.string() });
			const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
				name: "write_file",
				label: "Write",
				description: "Write a file",
				parameters: toolSchema,
				async execute(_id, params) {
					executed.push(params as Record<string, unknown>);
					return { content: [{ type: "text", text: "wrote" }], details: {} };
				},
			};
			const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "tc-1",
								name: "write_file",
								arguments: { path: "a.ts" },
								incompleteArguments: true,
							},
						],
						stopReason,
					},
					{ content: ["recovered"] },
				],
			});
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, fallbackManaged: true };
			const texts: string[] = [];
			const stream = agentLoop([createUserMessage("write the file")], context, config, undefined, mock.stream);
			for await (const event of stream) {
				if (event.type === "tool_execution_end") {
					expect(event.isError).toBe(true);
					const first = event.result.content?.[0];
					texts.push(first?.type === "text" ? first.text : "");
				}
			}
			expect(executed).toHaveLength(0);
			expect(texts).toHaveLength(1);
			expect(texts[0]).toContain('Tool call "write_file" was incomplete before its arguments finished streaming');
			expect(texts[0]).not.toContain("output token limit");
			expect(texts[0]).toContain("Re-issue the call with complete arguments");
		});
	}

	it("executes normally when incompleteArguments is not set", async () => {
		const executed: Array<Record<string, unknown>> = [];
		const toolSchema = z.object({ path: z.string() });
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "read_file",
			label: "Read",
			description: "Read a file",
			parameters: toolSchema,
			async execute(_id, params) {
				executed.push(params as Record<string, unknown>);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "read_file", arguments: { path: "a.ts" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const stream = agentLoop([createUserMessage("read it")], context, config, undefined, mock.stream);
		for await (const _ of stream) {
			// drain
		}
		expect(executed).toEqual([{ path: "a.ts" }]);
	});
});
