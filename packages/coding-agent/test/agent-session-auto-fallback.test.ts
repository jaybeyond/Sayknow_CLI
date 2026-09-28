import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentOptions } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { defaultModelPerProvider } from "@sayknow-cli/coding-agent/config/model-resolver";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@sayknow-cli/coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@sayknow-cli/coding-agent/slash-commands/types";
import { TempDir } from "@sayknow-cli/utils";

const selector = (model: Model) => `${model.provider}/${model.id}`;
const OPENAI_DEFAULT = `openai/${defaultModelPerProvider.openai}`;

function rateLimitStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage & { transportFailure: { kind: "transport"; status: number } } = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "usage limit reached",
			errorStatus: 429,
			timestamp: Date.now(),
			transportFailure: { kind: "transport", status: 429 },
		};
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

function successfulStream(model: Model): AssistantMessageEventStream {
	return createMockModel({ responses: [{ content: ["ok"] }] }).stream(model, {
		systemPrompt: [],
		messages: [],
		tools: [],
	});
}

describe("AgentSession automatic model fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!primary) throw new Error("Expected bundled anthropic model");

	beforeEach(async () => {
		tempDir = TempDir.createSync("@auto-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function createSession(
		settingsOverrides: Record<string, unknown>,
		streamFor: (model: Model) => AssistantMessageEventStream,
	): { calls: string[]; switches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> } {
		const calls: string[] = [];
		const switches: Array<Extract<AgentSessionEvent, { type: "model_fallback_switched" }>> = [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model => {
				calls.push(selector(model));
				return streamFor(model);
			}) satisfies AgentOptions["streamFn"],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 1,
			"retry.baseDelayMs": 1,
			...settingsOverrides,
		});
		settings.setModelRole("default", selector(primary!));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(event => {
			if (event.type === "model_fallback_switched") switches.push(event);
		});
		return { calls, switches };
	}

	it("moves to another logged-in provider before the turn when the default has no credentials", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { calls, switches } = createSession({}, successfulStream);

		const chain = session!.getDefaultFallbackChain();
		expect(chain.entries[0]).toBe(selector(primary));
		expect(chain.entries).toContain(OPENAI_DEFAULT);
		expect(chain.appendedFrom).toBe(1);

		await session!.prompt("hello");
		await session!.waitForIdle();

		expect(calls).toEqual([OPENAI_DEFAULT]);
		expect(selector(session!.model!)).toBe(OPENAI_DEFAULT);
		expect(switches).toEqual([
			expect.objectContaining({ from: selector(primary), to: OPENAI_DEFAULT, reason: "resolution" }),
		]);
		// The configured intent is not rewritten by an automatic pick.
		expect(session!.settings.getModelRole("default")).toBe(selector(primary));
	});

	it("moves to another logged-in provider mid-turn when the default is out of quota", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { calls, switches } = createSession({}, model =>
			selector(model) === selector(primary) ? rateLimitStream(model) : successfulStream(model),
		);

		await session!.prompt("hello");
		await session!.waitForIdle();

		expect(calls[0]).toBe(selector(primary));
		expect(calls.at(-1)).toBe(OPENAI_DEFAULT);
		expect(switches.at(-1)).toEqual(expect.objectContaining({ from: selector(primary), to: OPENAI_DEFAULT }));
		expect(selector(session!.model!)).toBe(OPENAI_DEFAULT);
	});

	it("tries the user's added fallbacks before automatic picks", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { calls } = createSession({ "fallback.models": ["openai/gpt-4o-mini"] }, successfulStream);

		const chain = session!.getDefaultFallbackChain();
		expect(chain.entries.slice(0, 2)).toEqual([selector(primary), "openai/gpt-4o-mini"]);
		// openai is already represented, so automatic picks add no second openai model.
		expect(chain.entries).not.toContain(OPENAI_DEFAULT);

		await session!.prompt("hello");
		await session!.waitForIdle();
		expect(calls).toEqual(["openai/gpt-4o-mini"]);
	});

	it("reports the missing login for the default provider when automatic fallback is off", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { calls } = createSession({ "fallback.auto": false }, successfulStream);
		expect(session!.getDefaultFallbackChain().entries).toEqual([selector(primary)]);

		let message = "";
		try {
			await session!.prompt("hello");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(calls).toEqual([]);
		expect(message).toContain("No credentials found for anthropic");
		expect(message).toContain("/login anthropic");
		expect(message).not.toContain("MiniMax");
	});

	it("keeps automatic picks inside an enabledModels allow-list", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		createSession({ enabledModels: ["anthropic/*"] }, successfulStream);
		expect(session!.getDefaultFallbackChain().entries).toEqual([selector(primary)]);
	});

	it("adds no automatic picks when retries are explicitly turned off", async () => {
		authStorage.setRuntimeApiKey("openai", "test-key");
		createSession({ "retry.enabled": false, "fallback.models": ["openai/gpt-4o-mini"] }, successfulStream);
		// Added models are explicit and still apply; automatic ones do not.
		expect(session!.getDefaultFallbackChain().entries).toEqual([selector(primary), "openai/gpt-4o-mini"]);
	});

	it("leaves an explicit --model and a subagent chain exactly as asked", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		createSession({ "fallback.models": ["openai/gpt-4o-mini"] }, successfulStream);
		expect(session!.getDefaultFallbackChain().entries.length).toBeGreaterThan(1);

		for (const origin of ["startup-override", "subagent"]) {
			session!.setConfiguredModelChain("default", [selector(primary)], origin, undefined, true);
			expect(session!.getDefaultFallbackChain().entries).toEqual([selector(primary)]);
		}
	});

	describe("/fallback", () => {
		async function run(args: string): Promise<string> {
			const outputs: string[] = [];
			const runtime = {
				session: session!,
				sessionManager: session!.sessionManager,
				settings: session!.settings,
				cwd: tempDir.path(),
				output: (text: string) => {
					outputs.push(text);
				},
				refreshCommands: () => undefined,
				reloadPlugins: async () => undefined,
			} as SlashCommandRuntime;
			const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(entry => entry.name === "fallback");
			await command!.handle!({ name: "fallback", args, text: `/fallback ${args}`.trim() }, runtime);
			return outputs.join("\n");
		}

		it("shows the chain with where each model came from", async () => {
			authStorage.setRuntimeApiKey("openai", "test-key");
			createSession({}, successfulStream);

			const shown = await run("");
			expect(shown).toContain("Model fallback (automatic: on)");
			expect(shown).toMatch(new RegExp(`1\\. ${selector(primary)}\\s+default  ← in use`));
			expect(shown).toMatch(new RegExp(`2\\. ${OPENAI_DEFAULT}\\s+auto`));
			expect(shown).toContain("order: balanced");
		});

		it("adds, removes and clears fallback models and toggles automatic picks", async () => {
			authStorage.setRuntimeApiKey("openai", "test-key");
			createSession({}, successfulStream);
			const settings = session!.settings;

			expect(await run("add openai/gpt-4o-mini")).toMatch(/2\. openai\/gpt-4o-mini\s+added/);
			expect(settings.get("fallback.models")).toEqual(["openai/gpt-4o-mini"]);
			expect(await run("add openai/gpt-4o-mini")).toContain("already a fallback");
			expect(await run("add nope/nothing")).toContain("Unknown model: nope/nothing");
			expect(settings.get("fallback.models")).toEqual(["openai/gpt-4o-mini"]);

			await run("remove 1");
			expect(settings.get("fallback.models")).toEqual([]);
			expect(await run("remove 1")).toContain("No fallback models are set");

			await run("add openai/gpt-4o-mini");
			await run("clear");
			expect(settings.get("fallback.models")).toEqual([]);

			const off = await run("auto off");
			expect(settings.get("fallback.auto")).toBe(false);
			expect(off).toContain("Nothing to fall back to");
			expect(session!.getDefaultFallbackChain().entries).toEqual([selector(primary)]);
			await run("auto on");
			expect(settings.get("fallback.auto")).toBe(true);

			expect(await run("auto maybe")).toContain("Usage: /fallback auto on|off");
			expect(await run("bogus")).toContain("Usage: /fallback");
		});
	});
});
