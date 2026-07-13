import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@sayknow-cli/agent-core";
import { Effort, type Model } from "@sayknow-cli/ai";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { logger } from "@sayknow-cli/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const INITIAL_MODEL: Model = {
	id: "initial",
	name: "Initial",
	api: "anthropic-messages",
	provider: "initial-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function targetModel(options?: { reasoning?: boolean; minLevel?: Effort; maxLevel?: Effort }): Model {
	return {
		...INITIAL_MODEL,
		id: options?.reasoning === false ? "plain" : "reasoning",
		name: "Target",
		provider: "target-provider",
		reasoning: options?.reasoning ?? true,
		thinking:
			options?.reasoning === false
				? undefined
				: { mode: "effort", minLevel: options?.minLevel ?? Effort.Low, maxLevel: options?.maxLevel ?? Effort.High },
	};
}

describe("AgentSession durable default model selection", () => {
	let tempRoot: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let activeStream: AssistantMessageEventStream | undefined;
	let streamCreated: PromiseWithResolvers<void>;

	beforeEach(async () => {
		streamCreated = Promise.withResolvers<void>();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skc-default-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey(INITIAL_MODEL.provider, "initial-key");
		authStorage.setRuntimeApiKey("target-provider", "target-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				activeStream = new AssistantMessageEventStream();
				streamCreated.resolve();
				return activeStream;
			},
		});
		sessionManager = SessionManager.inMemory(tempRoot);
		settings = Settings.isolated({ defaultThinkingLevel: Effort.XHigh });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		sessionManager.appendMessage({ role: "user", content: "existing transcript", timestamp: Date.now() });
	});

	afterEach(async () => {
		if (activeStream) {
			const message = createAssistantMessage("released during cleanup");
			activeStream.push({ type: "done", reason: "stop", message });
			activeStream.end(message);
			activeStream = undefined;
		}
		await session.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("waits for an in-flight response before any durable or session mutation", async () => {
		// Given
		const model = targetModel({ minLevel: Effort.Medium, maxLevel: Effort.High });
		const preflightComplete = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const apiKey = await originalGetApiKey(...args);
			preflightComplete.resolve();
			return apiKey;
		});
		const prompt = session.prompt("in flight");
		await streamCreated.promise;
		const entriesBeforeSelection = sessionManager.getEntries();
		const idleBarrierEntered = Promise.withResolvers<"idle">();
		const originalWaitForIdle = session.waitForIdle.bind(session);
		vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
			idleBarrierEntered.resolve("idle");
			await originalWaitForIdle();
		});
		const durableAttempted = Promise.withResolvers<"durable">();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableCommit = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			durableAttempted.resolve("durable");
			await originalDurableCommit(...args);
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.XHigh);
		await preflightComplete.promise;
		const firstMutationBoundary = await Promise.race([idleBarrierEntered.promise, durableAttempted.promise]);
		const durableCallsBeforeIdle = durableCommit.mock.calls.length;
		const modelBeforeIdle = session.model;
		const entriesWhileStreaming = sessionManager.getEntries();

		// Then
		const message = createAssistantMessage("complete");
		activeStream?.push({ type: "done", reason: "stop", message });
		activeStream?.end(message);
		activeStream = undefined;
		await prompt;
		const result = await selection;
		expect(firstMutationBoundary).toBe("idle");
		expect(durableCallsBeforeIdle).toBe(0);
		expect(modelBeforeIdle).toBe(INITIAL_MODEL);
		expect(entriesWhileStreaming).toEqual(entriesBeforeSelection);
		expect(result).toEqual({
			provider: "target-provider",
			modelId: "reasoning",
			thinkingLevel: Effort.High,
		});
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(Effort.High);
		const entriesAfterSelection = sessionManager.getEntries();
		expect(entriesAfterSelection.slice(0, entriesBeforeSelection.length)).toEqual(entriesBeforeSelection);
		expect(entriesAfterSelection.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(entriesAfterSelection.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: Effort.High }),
		]);
		const completedAssistantIndex = entriesAfterSelection.findIndex(
			(entry, index) =>
				index >= entriesBeforeSelection.length && entry.type === "message" && entry.message.role === "assistant",
		);
		const defaultModelMarkerIndex = entriesAfterSelection.findIndex(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const thinkingMarkerIndex = entriesAfterSelection.findIndex(entry => entry.type === "thinking_level_change");
		expect(completedAssistantIndex).toBeGreaterThanOrEqual(entriesBeforeSelection.length);
		expect(thinkingMarkerIndex).toBeGreaterThan(completedAssistantIndex);
		expect(defaultModelMarkerIndex).toBeGreaterThan(thinkingMarkerIndex);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
	});

	it("preserves explicit off for a reasoning model", async () => {
		// Given
		const model = targetModel();
		session.setThinkingLevel(ThinkingLevel.Off);
		const entriesBeforeSelection = sessionManager.getEntries();

		// When
		const result = await session.setDefaultModelSelection(model, ThinkingLevel.Off);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		const selectionEntries = sessionManager.getEntries().slice(entriesBeforeSelection.length);
		expect(selectionEntries.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(selectionEntries.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: ThinkingLevel.Off }),
		]);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:off" });
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});

	it("restores an unchanged explicit default thinking level on resume", async () => {
		// Given
		modelRegistry.registerProvider("target-provider", {
			baseUrl: "https://example.invalid/v1",
			apiKey: "resume-key",
			api: "openai-completions",
			models: [targetModel()],
		});
		const model = modelRegistry.find("target-provider", "reasoning");
		if (!model) throw new Error("Expected registered resume model");
		const sourceManager = SessionManager.create(tempRoot, tempRoot);
		const sourceSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: sourceManager,
			settings,
			modelRegistry,
			thinkingLevel: ThinkingLevel.Off,
		});
		const resumedSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			}),
			sessionManager: SessionManager.create(tempRoot, tempRoot),
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});

		try {
			const sourceSessionFile = sourceSession.sessionFile;
			if (!sourceSessionFile) throw new Error("Expected persisted source session");

			// When
			await sourceSession.setDefaultModelSelection(model, ThinkingLevel.Off);
			await sourceManager.rewriteEntries();
			expect(await resumedSession.switchSession(sourceSessionFile)).toBe(true);

			// Then
			expect(resumedSession.model?.provider).toBe(model.provider);
			expect(resumedSession.model?.id).toBe(model.id);
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
		} finally {
			await sourceSession.dispose();
			await resumedSession.dispose();
		}
	});

	it("normalizes an unspecified level to off for a non-reasoning model", async () => {
		// Given
		const model = targetModel({ reasoning: false });

		// When
		const result = await session.setDefaultModelSelection(model, undefined);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/plain:off" });
	});

	it("serializes concurrent selections so the FIFO last request owns durable, live, and resume defaults", async () => {
		// Given
		const firstModel = { ...targetModel(), id: "first" };
		const lastModel = { ...targetModel(), id: "last" };
		const firstLiveApplyEntered = Promise.withResolvers<void>();
		const releaseFirstLiveApply = Promise.withResolvers<void>();
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementation(async (model, thinkingLevel, options) => {
			if (model.id === firstModel.id) {
				firstLiveApplyEntered.resolve();
				await releaseFirstLiveApply.promise;
			}
			await originalLiveApply(model, thinkingLevel, options);
		});
		const lastPreflightEntered = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, ...args) => {
			if (model.id === lastModel.id) lastPreflightEntered.resolve();
			return originalGetApiKey(model, ...args);
		});

		// When
		const firstSelection = session.setDefaultModelSelection(firstModel, Effort.Low);
		await firstLiveApplyEntered.promise;
		const lastSelection = session.setDefaultModelSelection(lastModel, Effort.High);
		const preflightRace = Promise.withResolvers<boolean>();
		void lastPreflightEntered.promise.then(() => preflightRace.resolve(true));
		setImmediate(() => preflightRace.resolve(false));
		const lastRequestOvertookFirst = await preflightRace.promise;
		if (lastRequestOvertookFirst) await lastSelection;
		releaseFirstLiveApply.resolve();
		await Promise.all([firstSelection, lastSelection]);

		// Then
		expect(lastRequestOvertookFirst).toBeFalse();
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/last:high" });
		expect(session.model).toBe(lastModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/last");
	});

	it("rejects inherit before settings or session mutation", async () => {
		// Given
		const entriesBefore = sessionManager.getEntries();

		// When
		const selection = session.setDefaultModelSelection(targetModel(), ThinkingLevel.Inherit);

		// Then
		await expect(selection).rejects.toThrow(/inherit/i);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("rejects missing credentials before waiting or mutation", async () => {
		// Given
		const waitForIdle = vi.spyOn(session, "waitForIdle");
		const entriesBefore = sessionManager.getEntries();
		const model = { ...targetModel(), provider: "missing-provider" };

		// When
		const selection = session.setDefaultModelSelection(model, Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("No API key for missing-provider/reasoning");
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("does not apply the live selection when the durable commit fails", async () => {
		// Given
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(new Error("durable write failed"));
		const liveApply = vi.spyOn(session, "setModelTemporary");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("durable write failed");
		expect(liveApply).not.toHaveBeenCalled();
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("continues the selection queue after a rejected operation", async () => {
		// Given
		const successfulModel = { ...targetModel(), id: "after-failure" };
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush")
			.mockImplementation(originalDurableCommit)
			.mockRejectedValueOnce(new Error("durable write failed"));

		// When
		const failedSelection = session.setDefaultModelSelection(targetModel(), Effort.Low);
		await expect(failedSelection).rejects.toThrow("durable write failed");
		const successfulSelection = await session.setDefaultModelSelection(successfulModel, Effort.High);

		// Then
		expect(successfulSelection).toEqual({
			provider: "target-provider",
			modelId: "after-failure",
			thinkingLevel: Effort.High,
		});
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/after-failure:high" });
		expect(session.model).toBe(successfulModel);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(sessionManager.buildSessionContext().models.default).toBe("target-provider/after-failure");
	});

	it.each([
		[
			"the prior session default",
			"initial-provider/initial",
			{ default: "initial-provider/initial:low", planner: "planner/model:medium" },
		],
		["no prior session default", undefined, { planner: "planner/model:medium" }],
	])("restores %s when live apply fails after a partial session mutation", async (_description, previousSessionDefault, previousModelRoles) => {
		// Given
		if (previousSessionDefault) {
			sessionManager.appendModelChange(previousSessionDefault, "default");
		}
		settings.set("modelRoles", previousModelRoles);
		const entriesBeforeSelection = sessionManager.getEntries();
		const defaultEntriesBeforeSelection = entriesBeforeSelection.filter(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const liveApplyError = new Error("late live apply failure");
		const originalLiveApply = session.setModelTemporary.bind(session);
		vi.spyOn(session, "setModelTemporary").mockImplementation(async (...args) => {
			await originalLiveApply(...args);
			throw liveApplyError;
		});

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(liveApplyError);
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(
			sessionManager.getEntries().filter(entry => entry.type === "model_change" && entry.role === "default"),
		).toEqual(defaultEntriesBeforeSelection);
		expect(sessionManager.buildSessionContext().models.default === previousSessionDefault).toBeTrue();
	});

	it.each([
		["the previous default", { default: "original-provider/original:low", planner: "planner/model:medium" }],
		["no previous default", { planner: "planner/model:medium" }],
	])("restores %s when post-commit live apply fails", async (_description, previousModelRoles) => {
		// Given
		settings.set("modelRoles", previousModelRoles);
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(new Error("live apply failed"));

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow("live apply failed");
		expect(settings.getGlobal("modelRoles")).toEqual(previousModelRoles);
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("preserves the live apply error when restoring the durable default also fails", async () => {
		// Given
		const liveApplyError = new Error("live apply failed");
		const rollbackError = new Error("durable rollback failed");
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (role, modelId) => {
			if (modelId === undefined) throw rollbackError;
			await originalDurableCommit(role, modelId);
		});
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(liveApplyError);
		const rollbackWarning = vi.spyOn(logger, "warn");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toBe(liveApplyError);
		expect(rollbackWarning).toHaveBeenCalledWith(
			"Failed to restore durable default model selection after live apply failure",
			{ error: "Error: durable rollback failed" },
		);
	});
});
