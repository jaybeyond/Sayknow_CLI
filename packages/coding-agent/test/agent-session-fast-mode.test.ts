import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@sayknow-cli/agent-core";
import { getBundledModel } from "@sayknow-cli/ai/models";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

describe("AgentSession fast-mode predicate", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-fast-mode-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("returns false for an undefined provider even under an unscoped priority tier", () => {
		session.setServiceTier("priority");
		// Unscoped priority applies to a concrete provider...
		expect(session.isFastForProvider("anthropic")).toBe(true);
		expect(session.isFastForProvider("openai")).toBe(true);
		// ...but never when there is no provider (no model selected).
		expect(session.isFastForProvider(undefined)).toBe(false);
	});

	it("is provider-scoped for claude-only", () => {
		session.setServiceTier("claude-only");
		expect(session.isFastForProvider("anthropic")).toBe(true);
		expect(session.isFastForProvider("openai")).toBe(false);
		expect(session.isFastForProvider("openai-codex")).toBe(false);
		expect(session.isFastForProvider(undefined)).toBe(false);
	});

	it("isFastModeActive reflects the current model's provider and the configured tier", () => {
		expect(session.isFastModeActive()).toBe(false);
		session.setServiceTier("priority");
		// current model is anthropic
		expect(session.isFastModeActive()).toBe(true);
		// claude-only still matches the anthropic current model
		session.setServiceTier("claude-only");
		expect(session.isFastModeActive()).toBe(true);
		// openai-only does not match the anthropic current model
		session.setServiceTier("openai-only");
		expect(session.isFastModeActive()).toBe(false);
		session.setServiceTier(undefined);
		expect(session.isFastModeActive()).toBe(false);
	});
});
