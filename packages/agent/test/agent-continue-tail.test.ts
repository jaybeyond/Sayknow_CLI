import { describe, expect, it } from "bun:test";
import { Agent, canContinuePersistedHistory } from "@sayknow-cli/agent-core";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { createAssistantMessage } from "./helpers";

function userMessage() {
	return { role: "user" as const, content: "resume", timestamp: 1 };
}

function toolResultMessage() {
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "tool",
		content: [{ type: "text" as const, text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

function assistantMessage() {
	return createAssistantMessage([]);
}

describe("persisted continuation tail", () => {
	it("accepts user and tool-result tails but rejects empty and assistant tails", () => {
		expect(canContinuePersistedHistory([])).toBe(false);
		expect(canContinuePersistedHistory([userMessage()])).toBe(true);
		expect(canContinuePersistedHistory([toolResultMessage()])).toBe(true);
		expect(canContinuePersistedHistory([assistantMessage()])).toBe(false);
	});

	it("keeps assistant-tail queue handling separate from persisted-tail eligibility", async () => {
		const withoutQueue = new Agent();
		withoutQueue.replaceMessages([assistantMessage()]);
		await expect(withoutQueue.continue()).rejects.toThrow("Cannot continue from message role: assistant");

		const steeringMock = createMockModel({ responses: [{ content: ["steered"] }] });
		const withSteering = new Agent({ streamFn: steeringMock.stream });
		withSteering.replaceMessages([assistantMessage()]);
		withSteering.steer(userMessage());
		await expect(withSteering.continue()).resolves.toBeUndefined();
		expect(withSteering.hasQueuedSteering()).toBe(false);

		const followUpMock = createMockModel({ responses: [{ content: ["followed up"] }] });
		const withFollowUp = new Agent({ streamFn: followUpMock.stream });
		withFollowUp.replaceMessages([assistantMessage()]);
		withFollowUp.followUp(userMessage());
		await expect(withFollowUp.continue()).resolves.toBeUndefined();
		expect(withFollowUp.hasQueuedMessages()).toBe(false);
	});
});

describe("tool filter projection", () => {
	function namedTool(name: string) {
		let runs = 0;
		return {
			runs: () => runs,
			tool: {
				name,
				label: name,
				description: name,
				parameters: { type: "object" as const, properties: {} },
				execute: async () => {
					runs++;
					return { content: [{ type: "text" as const, text: `${name} ran` }] };
				},
			},
		};
	}

	it("narrows what the model sees and may execute without changing the selected tools", async () => {
		const read = namedTool("read");
		const write = namedTool("write");
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "w1", name: "write", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			streamFn: mock.stream,
			initialState: { model: mock, systemPrompt: [], tools: [read.tool, write.tool], messages: [] },
		});
		agent.setToolFilter(tools => tools.filter(tool => tool.name === "read"));

		await agent.prompt("go");

		expect(mock.calls[0]?.context.tools?.map(tool => tool.name)).toEqual(["read"]);
		expect(write.runs()).toBe(0);
		expect(agent.state.tools.map(tool => tool.name)).toEqual(["read", "write"]);
	});

	it("drops a forced tool choice that names a filtered-out tool", async () => {
		const read = namedTool("read");
		const write = namedTool("write");
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const agent = new Agent({
			streamFn: mock.stream,
			initialState: { model: mock, systemPrompt: [], tools: [read.tool, write.tool], messages: [] },
		});
		agent.setToolFilter(tools => tools.filter(tool => tool.name === "read"));

		await agent.prompt("go", { toolChoice: { type: "tool", name: "write" } });

		const choice = mock.calls[0]?.options?.toolChoice;
		expect(JSON.stringify(choice ?? null)).not.toContain("write");
	});
});
