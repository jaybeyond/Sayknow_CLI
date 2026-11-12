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

describe("AgentSession security review skill reminder", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@security-skill-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	/** Everything the model was sent for the turn started by `prompt`. */
	async function contextFor(prompt: string, options?: { synthetic?: boolean }): Promise<string> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const seen: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			// The production converter: it keeps developer messages, the default one drops them.
			convertToLlm,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: ((streamModel, context, streamOptions) => {
				seen.push(context.messages as Message[]);
				return createMockModel({ responses: [{ content: ["ok"] }] }).stream(streamModel, context, streamOptions);
			}) satisfies AgentOptions["streamFn"],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "decisions.enabled": false, "todo.eager": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		await session.prompt(prompt, options);
		await session.waitForIdle();
		return JSON.stringify(seen.at(-1));
	}

	it("tells the model to load security-review for a security review turn", async () => {
		const context = await contextFor("Do a security review of the upload handler");
		expect(context).toContain("SKC detected security review work in this prompt");
		expect(context).toContain("`security-review`");
		expect(context).toContain("never send test input to a system you were not told to test");
	});

	it("adds nothing for a turn that is not a security review", async () => {
		const context = await contextFor("Rename the upload handler to uploadFile");
		expect(context).not.toContain("SKC detected security review work");
	});

	it("does not fire on a synthetic prompt that merely quotes the phrase", async () => {
		const context = await contextFor("Reminder: the last tool output mentioned a security review", {
			synthetic: true,
		});
		expect(context).not.toContain("SKC detected security review work");
	});
});
