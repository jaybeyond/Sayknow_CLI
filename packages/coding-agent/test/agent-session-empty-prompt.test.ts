import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@sayknow-cli/agent-core";
import { getBundledModel } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

const WHITESPACE_ONLY = ["", " ", "\n", " \n\t "];

describe("AgentSession empty prompt rejection", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let streamCalls = 0;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@skc-empty-prompt-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
		streamCalls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (...args: Parameters<typeof mock.stream>) => {
				streamCalls++;
				return mock.stream(...args);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function current(): AgentSession {
		if (!session) throw new Error("session not initialised");
		return session;
	}

	it("rejects whitespace-only text at every public entry point without starting a turn", async () => {
		const s = current();
		for (const text of WHITESPACE_ONLY) {
			await expect(s.prompt(text)).rejects.toThrow("Prompt must not be empty.");
			await expect(s.steer(text)).rejects.toThrow("Prompt must not be empty.");
			await expect(s.followUp(text)).rejects.toThrow("Prompt must not be empty.");
			await expect(s.sendUserMessage(text)).rejects.toThrow("Prompt must not be empty.");
			await expect(s.sendUserMessage([{ type: "text", text }])).rejects.toThrow("Prompt must not be empty.");
		}
		expect(streamCalls).toBe(0);
		expect(s.agent.state.messages).toHaveLength(0);
	});

	it("rejects an image block without usable payload and malformed content blocks", async () => {
		const s = current();
		await expect(s.prompt(" ", { images: [{ type: "image", data: "", mimeType: "image/png" }] })).rejects.toThrow(
			"Prompt must not be empty.",
		);
		await expect(s.sendUserMessage([null as never])).rejects.toThrow("content blocks must be objects");
		await expect(s.sendUserMessage([{ type: "text", text: 42 as never }])).rejects.toThrow(
			"text blocks must contain string text",
		);
		expect(streamCalls).toBe(0);
	});

	it("keeps non-empty multiline Unicode prompts flowing to the model", async () => {
		const s = current();
		await s.prompt("\n  第一行\n第二行 — café\n");
		await s.waitForIdle();
		expect(streamCalls).toBe(1);
		const user = s.agent.state.messages.find(message => message.role === "user");
		expect(JSON.stringify(user?.content)).toContain("第二行 — café");
	});
});
