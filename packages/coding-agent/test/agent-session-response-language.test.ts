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

	async function contextFor(
		prompt: string,
		options?: { attribution?: "agent"; before?: string; responseLanguage?: { code: string; name: string } },
	): Promise<string> {
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
				return createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] }).stream(
					streamModel,
					context,
					options,
				);
			}) satisfies AgentOptions["streamFn"],
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "decisions.enabled": false, "todo.eager": false }),
			modelRegistry: new ModelRegistry(authStorage),
			responseLanguage: options?.responseLanguage,
		});
		if (options?.before) {
			await session.prompt(options.before);
			await session.waitForIdle();
		}
		await session.prompt(prompt, options?.attribution ? { attribution: options.attribution } : undefined);
		await session.waitForIdle();
		return JSON.stringify(seen.at(-1)?.slice(-2));
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

	it("answers an English subagent assignment in the inherited user language", async () => {
		const context = await contextFor("Investigate the failing broker test and report findings", {
			attribution: "agent",
			responseLanguage: { code: "ko", name: "Korean" },
		});
		expect(context).toContain("The user wrote in Korean.");
		expect(session!.getResponseLanguage()?.code).toBe("ko");
	});

	it("keeps the latest user language for later agent-attributed prompts", async () => {
		const context = await contextFor("Continue from the paused subagent session state.", {
			attribution: "agent",
			before: "브로커 테스트를 고쳐줘",
		});
		expect(context).toContain("The user wrote in Korean.");
	});

	it("lets a later English user prompt clear the inherited language", async () => {
		const context = await contextFor("Now answer in English please", {
			responseLanguage: { code: "ko", name: "Korean" },
		});
		expect(context).not.toContain("The user wrote in");
		expect(session!.getResponseLanguage()).toBeUndefined();
	});
});
