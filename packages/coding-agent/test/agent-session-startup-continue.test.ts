import { describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@sayknow-cli/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@sayknow-cli/ai";
import { getBundledModel } from "@sayknow-cli/ai/models";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";

function testModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic test model");
	return model;
}

function assistantTail(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "completed" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

function toolResultTail(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 0,
	};
}

async function createSession(messages: AgentMessage[]): Promise<AgentSession> {
	const agent = new Agent({ initialState: { model: testModel(), systemPrompt: ["Test"], tools: [], messages } });
	const authStorage = await AuthStorage.create(":memory:");
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage),
	});
}

describe("AgentSession startup continuation", () => {
	it("rejects empty and terminal assistant persisted tails without calling Agent.continue", async () => {
		const terminalTails: AgentMessage[][] = [[], [assistantTail()]];
		for (const messages of terminalTails) {
			const session = await createSession(messages);
			try {
				const continueSpy = vi.spyOn(session.agent, "continue");

				await expect(session.continuePersistedHistory()).rejects.toThrow(
					"Cannot continue from persisted message history",
				);
				expect(continueSpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		}
	});

	it("delegates and awaits Agent.continue exactly once for user and tool-result tails", async () => {
		const resumableTails: AgentMessage[][] = [
			[{ role: "user", content: "resume", timestamp: 0 }],
			[{ role: "user", content: "resume", timestamp: 0 }, toolResultTail()],
		];
		for (const messages of resumableTails) {
			const session = await createSession(messages);
			try {
				const completion = Promise.withResolvers<void>();
				const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(() => completion.promise);
				const continuation = session.continuePersistedHistory();

				await Promise.resolve();
				expect(continueSpy).toHaveBeenCalledTimes(1);
				let settled = false;
				void continuation.then(() => {
					settled = true;
				});
				await Promise.resolve();
				expect(settled).toBe(false);
				completion.resolve();
				await continuation;
			} finally {
				await session.dispose();
			}
		}
	});

	it("propagates Agent.continue rejection", async () => {
		const session = await createSession([{ role: "user", content: "resume", timestamp: 0 }]);
		const expected = new Error("continuation failed");
		const continueSpy = vi.spyOn(session.agent, "continue").mockRejectedValue(expected);

		await expect(session.continuePersistedHistory()).rejects.toBe(expected);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		await session.dispose();
	});
});
