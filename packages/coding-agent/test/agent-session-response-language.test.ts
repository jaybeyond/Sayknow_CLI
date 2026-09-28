import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentOptions } from "@sayknow-cli/agent-core";
import { getBundledModel, type Message } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

describe("AgentSession reply-language reminder", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@reply-language-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	async function contextFor(prompt: string): Promise<string> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const seen: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			// The production converter: it keeps developer messages, the default one drops them.
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((streamModel, context, options) => {
				seen.push(context.messages as Message[]);
				return createMockModel({ responses: [{ content: ["ok"] }] }).stream(streamModel, context, options);
			}) satisfies AgentOptions["streamFn"],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "decisions.enabled": false, "todo.eager": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt(prompt);
		await session.waitForIdle();
		return JSON.stringify(seen.at(-1));
	}

	it("names Korean at the start of a turn written in Korean", async () => {
		const context = await contextFor("브로커 테스트가 왜 실패하는지 확인해줘");
		expect(context).toContain("The user wrote in Korean.");
		expect(context).toContain("the final report after tool work");
	});

	it("adds nothing for an English turn", async () => {
		const context = await contextFor("Check why the broker test fails");
		expect(context).not.toContain("The user wrote in");
	});
});
