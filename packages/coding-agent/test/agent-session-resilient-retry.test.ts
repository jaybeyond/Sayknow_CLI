import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool, type StreamFn } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model, type ToolCall } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { ExtensionRunner } from "@sayknow-cli/coding-agent/extensibility/extensions/runner";
import type { Extension } from "@sayknow-cli/coding-agent/extensibility/extensions/types";
import { AgentSession, type AgentSessionEvent } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

function assistantMessage(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

/**
 * Resilient-retry contract (deep-interview spec):
 *  - configured transient + unknown/no-code errors retry according to the legacy policy,
 *    capped at retry.maxDelayMs (ceiling, not give-up);
 *  - clearly-terminal coded errors (auth/400/not-found) surface immediately;
 *  - retry.enabled=false surfaces immediately;
 *  - first Esc (retryNow) skips the backoff; abortRetry cancels.
 */
describe("AgentSession resilient retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-resilient-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function buildSession(options: {
		responses: Array<{ throw: string } | { content: string[] }>;
		settingsOverrides?: Record<string, unknown>;
		requestedModels?: string[];
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: options.responses });
		const requestedModels = options.requestedModels ?? [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, opts);
			},
		});
		const settings = Settings.isolated({
			// Single-model retry policy under test: the mock stream records a `mock` model, so an
			// automatic fallback to the keyed provider would turn this into a managed chain.
			"fallback.auto": false,
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 1,
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function buildStatusErrorSession(options: {
		model?: Model;
		errorMessage?: string;
		errorStatus?: number;
		errorKind?: AssistantMessage["errorKind"];
		transportFailure?: AssistantMessage["transportFailure"];
		recoveredContent?: string;
		partialContent?: string;
		bareDefault?: boolean;
		messageApi?: AssistantMessage["api"];
		messageProvider?: string;
		messageModel?: string;
		requestedModels?: string[];
		settingsOverrides?: Record<string, unknown>;
	}): AgentSession {
		const model = options.model ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const requestedModels = options.requestedModels ?? [];
		let calls = 0;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				calls++;
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				if (calls > 1 && options.recoveredContent) {
					return createMockModel({ responses: [{ content: [options.recoveredContent] }] }).stream(
						requestedModel,
						context,
						opts,
					);
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: options.partialContent ? [{ type: "text", text: options.partialContent }] : [],
						api: options.messageApi ?? requestedModel.api,
						provider: options.messageProvider ?? requestedModel.provider,
						model: options.messageModel ?? requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
						...(options.errorStatus === undefined ? {} : { errorStatus: options.errorStatus }),
						...(options.errorKind === undefined ? {} : { errorKind: options.errorKind }),
						...(options.transportFailure === undefined ? {} : { transportFailure: options.transportFailure }),
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({
			// Single-model retry policy under test: the mock stream records a `mock` model, so an
			// automatic fallback to the keyed provider would turn this into a managed chain.
			"fallback.auto": false,
			"compaction.enabled": false,
			...(options.bareDefault
				? {}
				: {
						"retry.baseDelayMs": 1,
						"retry.maxDelayMs": 10,
						"retry.maxRetries": 1,
					}),
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	// Builds a session pinned to an explicit model (e.g. ollama-cloud) so
	// provider-scoped retry behavior can be exercised. The mock streams as
	// itself, so the active model's API remains authoritative for provider-scoped
	// policies that intentionally use active-model state (such as #713).
	function buildModelSession(options: {
		model: Model;
		responses: Array<{ throw: string } | { content: string[] }>;
		settingsOverrides?: Record<string, unknown>;
		requestedModels?: string[];
		bareDefault?: boolean;
	}): AgentSession {
		const { model } = options;
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const mock = createMockModel({ responses: options.responses });
		const requestedModels = options.requestedModels ?? [];
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, opts);
			},
		});
		const settings = Settings.isolated({
			// Single-model retry policy under test: the mock stream records a `mock` model, so an
			// automatic fallback to the keyed provider would turn this into a managed chain.
			"fallback.auto": false,
			"compaction.enabled": false,
			...(options.bareDefault
				? {}
				: {
						"retry.baseDelayMs": 1,
						"retry.maxDelayMs": 10,
						"retry.maxRetries": 1,
					}),
			...options.settingsOverrides,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}
	// Builds a single-model session with a BARE default retry configuration:
	// no explicit retry.* keys are set, so `legacyRetryConfigured` is false.
	// This mirrors the real-world default and guards the regression where
	// provider stream timeouts silently failed without retrying (agent idle).
	function buildBareRetrySession(options: {
		responses: Array<{ throw: string; responseHeaders?: Record<string, string> } | { content: string[] }>;
		requestedModels?: string[];
		onStreamStart?: (agent: Agent) => void;
		emitProviderPayload?: boolean;
		extensionRunner?: ExtensionRunner;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses: options.responses });
		const extensionRunner = options.extensionRunner;
		const requestedModels = options.requestedModels ?? [];
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			transformContext: extensionRunner ? messages => extensionRunner.emitContext(messages) : undefined,
			onPayload: extensionRunner ? payload => extensionRunner.emitBeforeProviderRequest(payload) : undefined,
			streamFn: (requestedModel, context, opts) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				options.onStreamStart?.(agent);
				if (options.emitProviderPayload) void opts?.onPayload?.({});
				return mock.stream(requestedModel, context, opts);
			},
		});
		// Only compaction is disabled; no retry.* keys are seeded.
		const settings = Settings.isolated({
			// Single-model retry policy under test: the mock stream records a `mock` model, so an
			// automatic fallback to the keyed provider would turn this into a managed chain.
			"fallback.auto": false,
			"compaction.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			onResponse: extensionRunner
				? async (response, model) => {
						await extensionRunner.emitAfterProviderResponse(response, model);
					}
				: undefined,
		});
	}
	function buildBareStreamingSession(options: {
		tools?: AgentTool[];
		streamFn: StreamFn;
		extensionRunner?: ExtensionRunner;
		sessionManager?: SessionManager;
	}): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: options.streamFn,
			// Production converter: session custom messages reach the model as user turns.
			convertToLlm,
		});
		const settings = Settings.isolated({
			// Single-model retry policy under test: the mock stream records a `mock` model, so an
			// automatic fallback to the keyed provider would turn this into a managed chain.
			"fallback.auto": false,
			"compaction.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner: options.extensionRunner,
		});
	}
	function createExtensionRunner(handlers = new Map<string, Array<() => Promise<void>>>()) {
		const extension: Extension = {
			path: "test-extension",
			resolvedPath: "test-extension",
			handlers: handlers as Extension["handlers"],
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		return new ExtensionRunner(
			handlers.size === 0 ? [] : [extension],
			{ flagValues: new Map(), pendingProviderRegistrations: [] } as never,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);
	}
	function track(s: AgentSession) {
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		s.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		return { retryStartEvents, retryEndEvents };
	}

	it("caps transient retries at an explicit retry.maxRetries instead of retrying unbounded", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger transient errors beyond maxRetries");
		await session.waitForIdle();

		// Explicit retry.maxRetries=1: one same-model retry, then the real error surfaces.
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents.every(e => e.unbounded === false)).toBe(true);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "error",
			errorMessage: "503 service unavailable: overloaded_error",
		});
		expect(waitSpy).toHaveBeenCalled();
	});

	it("bounds default transient recovery to seven same-model requests per step", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: Array.from({ length: 14 }, () => ({ throw: "503 service unavailable: overloaded_error" })),
			settingsOverrides: { "retry.maxRetries": undefined },
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger persistent transient errors");
		await session.waitForIdle();

		// 1 original + 6 recovery requests, then stop on the same model with the real error.
		expect(requestedModels).toHaveLength(7);
		expect(new Set(requestedModels).size).toBe(1);
		expect(retryStartEvents).toHaveLength(6);
		expect(retryStartEvents.every(e => e.unbounded === false && e.maxAttempts === 6)).toBe(true);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: false })]);
		expect(lastAssistant(session)).toMatchObject({ stopReason: "error" });
		expect(session.isRetrying).toBe(false);

		// The next user turn starts a fresh step budget on the same model.
		requestedModels.length = 0;
		await session.prompt("try again");
		await session.waitForIdle();
		expect(requestedModels).toHaveLength(7);
	});

	it("retries unknown / no-code errors within retry.maxRetries", async () => {
		session = buildSession({
			responses: [{ throw: "weird unclassified glitch zzz" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger unknown error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].unbounded).toBe(false);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("surfaces terminal coded errors without retrying", async () => {
		session = buildSession({
			responses: [{ throw: "401 unauthorized: invalid api key" }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger terminal error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("401");
	});
	it("surfaces typed provider safety stops without text and without retrying", async () => {
		session = buildStatusErrorSession({
			errorKind: "provider_safety_stop",
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger typed provider safety stop");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorKind).toBe("provider_safety_stop");
		expect(last.errorMessage).toBeUndefined();
	});
	it("surfaces persisted legacy provider safety stops without retrying", async () => {
		session = buildStatusErrorSession({
			errorMessage: "Refusal (no details provided)",
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger persisted legacy provider safety stop");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorKind).toBeUndefined();
		expect(last.errorMessage).toBe("Refusal (no details provided)");
	});

	it("surfaces provider safety refusals without retrying", async () => {
		// Anthropic stop_reason "refusal"/"sensitive" maps to stopReason "error"
		// with an engine-generated label (packages/ai anthropic.ts). Refusals are
		// deterministic for the submitted context, so every retry re-sends the
		// full conversation and deterministically refuses again (#1655).
		const refusals = [
			"Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.",
			"Refusal (no details provided)",
			"Content flagged by safety filters",
			"Blocked under Anthropic's Usage Policy.",
			"Provider finish_reason: content_filter",
			"provider FINISH_REASON: CONTENT_FILTER\t",
		];
		for (const refusal of refusals) {
			session = buildSession({ responses: [{ throw: refusal }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("trigger provider refusal");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			const last = lastAssistant(session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toBe(refusal);
			await session.dispose();
			session = undefined;
		}
	});

	it("retries errors that merely mention legacy safety-stop labels mid-sentence", async () => {
		const incidentalMessages = [
			"connection error after upstream refusal handshake",
			"connection error: content flagged by safety filters in a prior response",
			"connection error: request was blocked under Anthropic's Usage Policy while retrying",
			"connection error: Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter timeout",
			"Content flagged by safety filtersXYZ",
			"Blocked under vendor Usage Policymaker timeout",
			"Refusal (unterminated transient transport error",
			" Provider finish_reason: content_filter",
			"Provider finish_reason: content_filter\n",
			"Provider finish_reason: content_filter\r\n",
			"Refusal: ",
			"Refusal (cyber): ",
			"Refusal( cyber )",
			"Refusal ( cyber)",
			"Refusal (cyber )",
			"Refusal (cy(ber))",
			"Blocked under xUsage Policy",
			"Provider finish_reason:content_filter",
			"Provider finish_reason:\tcontent_filter",
			"Provider finish_reason:  content_filter",
			"Provider finish_reason: \tcontent_filter",
		];
		for (const errorMessage of incidentalMessages) {
			session = buildSession({
				responses: [{ throw: errorMessage }, { content: ["recovered"] }],
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("mid-sentence legacy safety-stop label");
			await session.waitForIdle();

			expect(retryStartEvents.length).toBeGreaterThanOrEqual(1);
			expect(lastAssistant(session).stopReason).toBe("stop");
			await session.dispose();
			session = undefined;
		}
	}, 30_000);

	it("surfaces deliberate request aborts without retrying", async () => {
		session = buildSession({ responses: [{ throw: "Request was aborted." }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("deliberate abort");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries network-abort style errors (not deliberate request aborts)", async () => {
		// "connection aborted" is a transient network hiccup, not a deliberate
		// abort: it must retry rather than be misclassified as terminal.
		session = buildSession({
			responses: [{ throw: "socket connection aborted" }, { content: ["recovered"] }],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("network abort");
		await session.waitForIdle();

		expect(retryStartEvents.length).toBeGreaterThanOrEqual(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("does not retry when retry.enabled is false", async () => {
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }],
			settingsOverrides: { "retry.enabled": false },
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger transient with retry disabled");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retryNow skips the backoff and re-attempts immediately", async () => {
		// Huge backoff: the retry only completes within the test timeout if
		// retryNow() short-circuits the wait.
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["recovered now"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryStartEvents, retryEndEvents } = track(session);
		let resolveStarted!: () => void;
		const started = new Promise<void>(r => {
			resolveStarted = r;
		});
		let resolveEnded!: () => void;
		const ended = new Promise<void>(r => {
			resolveEnded = r;
		});
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				resolveStarted();
				session?.retryNow();
			}
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then retry-now").catch(() => {});
		await started;
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("abortRetry cancels the retry and surfaces the error", async () => {
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["should not reach"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryEndEvents } = track(session);
		let resolveStarted!: () => void;
		const started = new Promise<void>(r => {
			resolveStarted = r;
		});
		let resolveEnded!: () => void;
		const ended = new Promise<void>(r => {
			resolveEnded = r;
		});
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				resolveStarted();
				session?.abortRetry();
			}
			if (event.type === "auto_retry_end") resolveEnded();
		});

		const prompt = session.prompt("trigger retry then cancel").catch(() => {});
		await started;
		await ended;
		await prompt;
		await session.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("cancelled");
		// The errored assistant message was stripped in preparation for the retry,
		// so cancellation simply returns to idle (the error remains in session history).
		expect(session.isRetrying).toBe(false);
	});
	it("surfaces 400 bad-request errors without retrying", async () => {
		session = buildSession({ responses: [{ throw: "400 Bad Request: malformed messages" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger bad request");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces numeric HTTP 4xx (status context) without retrying", async () => {
		// No "bad request" keyword — relies on HTTP-status extraction so a bare
		// numeric 4xx is treated terminal instead of looping as "unknown".
		session = buildSession({ responses: [{ throw: "HTTP 400: malformed request payload" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger numeric 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces explicit HTTP 400 messages even when text contains transient substrings", async () => {
		for (const errorMessage of [
			"HTTP 400: provider returned error",
			"HTTP 400: max 500 tool calls exceeded",
			"HTTP 400: request timed out during validation",
		] as const) {
			if (session) {
				await session.dispose();
				session = undefined;
			}
			session = buildSession({ responses: [{ throw: errorMessage }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`trigger explicit terminal 400: ${errorMessage}`);
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(lastAssistant(session).stopReason).toBe("error");
		}
	});

	it("surfaces structured HTTP 400 even when text contains transient substrings", async () => {
		session = buildStatusErrorSession({
			errorMessage: "provider returned error",
			errorStatus: 400,
			recoveredContent: "should not retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger structured terminal 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("surfaces explicit status-code 4xx errors without retrying", async () => {
		session = buildSession({ responses: [{ throw: "provider returned status code 400 for malformed payload" }] });
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("trigger status-code 400");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries rate-limit text with incidental 4xx numbers even when provider status extraction says 400", async () => {
		session = buildStatusErrorSession({
			errorMessage: "rate limit error: 400 requests per minute",
			errorStatus: 400,
			recoveredContent: "recovered after rate-limit retry",
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("trigger misleading rate limit status");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("does not terminalize retryable explicit HTTP statuses", async () => {
		for (const [status, message] of [
			[408, "HTTP 408 request timeout"],
			[425, "HTTP 425 too early retry your request"],
			[429, "HTTP 429 rate limit exceeded"],
			[503, "HTTP 503 service unavailable"],
		] as const) {
			if (session) {
				await session.dispose();
				session = undefined;
			}
			session = buildSession({ responses: [{ throw: message }, { content: [`recovered ${status}`] }] });
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`trigger retryable HTTP ${status}`);
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("stop");
		}
	});

	it("emits auto_retry_end when a retry ends on a terminal error", async () => {
		// First a transient error (retries), then a terminal 401 that must not
		// retry — the retry session must emit a terminal auto_retry_end.
		session = buildSession({
			responses: [
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "401 unauthorized: invalid api key" },
			],
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("transient then terminal");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(session.isRetrying).toBe(false);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("honors retryNow() invoked synchronously from the auto_retry_start subscriber", async () => {
		// Regression for the controller-assignment race: retryNow() fired the
		// instant auto_retry_start arrives must still skip the (huge) backoff.
		session = buildSession({
			responses: [{ throw: "503 service unavailable: overloaded_error" }, { content: ["recovered now"] }],
			settingsOverrides: { "retry.baseDelayMs": 600_000, "retry.maxDelayMs": 600_000 },
		});
		const { retryEndEvents } = track(session);
		const sess = session;
		sess.subscribe(event => {
			if (event.type === "auto_retry_start") sess.retryNow();
		});

		await sess.prompt("retry-now race");
		await sess.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(sess).stopReason).toBe("stop");
	});

	it("surfaces exact Alibaba Token Plan first-event timeouts without duplicate model retries", async () => {
		const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		if (!responsesModel || !completionsModel) throw new Error("Expected bundled Alibaba Token Plan models");
		expect(responsesModel.api).toBe("openai-responses");

		const cases = [
			{
				model: responsesModel,
				errorMessage: "Provider stream timed out while waiting for the first event",
				settingsOverrides: { "retry.maxRetries": 10 },
				bareDefault: false,
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event",
				settingsOverrides: { "retry.maxRetries": 10 },
				bareDefault: false,
			},
			{
				model: completionsModel,
				errorMessage: "Provider stream timed out while waiting for the first event",
				settingsOverrides: undefined,
				bareDefault: true,
			},
			{
				model: completionsModel,
				errorMessage: "OpenAI completions stream timed out while waiting for the first event",
				settingsOverrides: undefined,
				bareDefault: true,
			},
		] as const;
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		for (const testCase of cases) {
			const requestedModels: string[] = [];
			session = buildStatusErrorSession({
				model: testCase.model,
				errorMessage: testCase.errorMessage,
				recoveredContent: "unused retry",
				requestedModels,
				bareDefault: testCase.bareDefault,
				settingsOverrides: testCase.settingsOverrides,
			});
			const { retryStartEvents, retryEndEvents } = track(session);

			await session.prompt(`Alibaba ${testCase.model.api} first-event timeout`);
			await session.waitForIdle();

			expect(requestedModels).toEqual([`${testCase.model.provider}/${testCase.model.id}`]);
			expect(new Set(requestedModels).size).toBe(requestedModels.length);
			expect(retryStartEvents).toHaveLength(0);
			expect(retryEndEvents).toHaveLength(0);
			expect(waitSpy).not.toHaveBeenCalled();
			const final = lastAssistant(session);
			expect(final).toMatchObject({
				stopReason: "error",
				provider: testCase.model.provider,
				api: testCase.model.api,
				model: testCase.model.id,
				errorMessage: testCase.errorMessage,
			});
			expect(session.isRetrying).toBe(false);
			expect(session.isStreaming).toBe(false);

			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	});

	it("uses failed AssistantMessage identity rather than the active model for Alibaba timeout policy", async () => {
		const alibabaModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!alibabaModel || !anthropicModel) throw new Error("Expected bundled test models");
		const timeoutMessage = "Provider stream timed out while waiting for the first event";
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		const retryRequestedModels: string[] = [];
		session = buildStatusErrorSession({
			model: alibabaModel,
			errorMessage: timeoutMessage,
			messageProvider: "openai",
			messageApi: "openai-responses",
			recoveredContent: "recovered after provider mismatch",
			requestedModels: retryRequestedModels,
		});
		const retryEvents = track(session);
		await session.prompt("Alibaba active model with non-Alibaba failed message");
		await session.waitForIdle();
		expect(retryRequestedModels).toHaveLength(2);
		expect(retryEvents.retryStartEvents).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
		await session.dispose();
		session = undefined;
		waitSpy.mockClear();

		const terminalRequestedModels: string[] = [];
		session = buildStatusErrorSession({
			model: anthropicModel,
			errorMessage: timeoutMessage,
			messageProvider: "alibaba-token-plan",
			messageApi: "openai-responses",
			messageModel: alibabaModel.id,
			recoveredContent: "should-not-reach",
			requestedModels: terminalRequestedModels,
		});
		const terminalEvents = track(session);
		await session.prompt("Non-Alibaba active model with Alibaba failed message");
		await session.waitForIdle();
		expect(terminalRequestedModels).toHaveLength(1);
		expect(terminalEvents.retryStartEvents).toHaveLength(0);
		expect(waitSpy).not.toHaveBeenCalled();
		expect(lastAssistant(session)).toMatchObject({
			stopReason: "error",
			provider: "alibaba-token-plan",
			api: "openai-responses",
			model: alibabaModel.id,
			errorMessage: timeoutMessage,
		});
	});

	it("keeps Alibaba near misses, cross-API text, and unrelated transient failures retryable", async () => {
		const responsesModel = getBundledModel("alibaba-token-plan", "qwen3.8-max-preview");
		const completionsModel = getBundledModel("alibaba-token-plan", "deepseek-v4-pro");
		if (!responsesModel || !completionsModel) throw new Error("Expected bundled Alibaba Token Plan models");
		const cases = [
			{
				model: responsesModel,
				errorMessage: "Error: OpenAI responses stream timed out while waiting for the first event",
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event.",
			},
			{
				model: responsesModel,
				errorMessage: "OpenAI completions stream timed out while waiting for the first event",
			},
			{
				model: completionsModel,
				errorMessage: "OpenAI responses stream timed out while waiting for the first event",
			},
			{ model: completionsModel, errorMessage: "Alibaba stream stalled while waiting for the next event" },
			{ model: completionsModel, errorMessage: "503 service unavailable" },
			{ model: completionsModel, errorMessage: "429 rate limit exceeded" },
			{ model: completionsModel, errorMessage: "network error: connection reset" },
		] as const;
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		for (const testCase of cases) {
			const requestedModels: string[] = [];
			session = buildModelSession({
				model: testCase.model,
				responses: [{ throw: testCase.errorMessage }, { content: ["recovered"] }],
				requestedModels,
			});
			const { retryStartEvents, retryEndEvents } = track(session);
			await session.prompt(`Alibaba non-terminal ${testCase.errorMessage}`);
			await session.waitForIdle();
			expect(requestedModels).toHaveLength(2);
			expect(retryStartEvents).toHaveLength(1);
			expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(waitSpy).toHaveBeenCalled();
			await session.dispose();
			session = undefined;
			waitSpy.mockClear();
		}
	});

	it("bounds ollama-cloud first-event timeout retries instead of looping unbounded (#713)", async () => {
		// ollama-cloud (ollama-chat API) can stall before its first token even
		// for tiny prompts. Unbounded continuation retries re-issue the full
		// request to a billable backend and spike usage; the retry must be
		// capped at retry.maxRetries and then surface.
		const model = getBundledModel("ollama-cloud", "gpt-oss:120b");
		if (!model) throw new Error("Expected bundled ollama-cloud test model to exist");
		const timeoutMessage = "Provider stream timed out while waiting for the first event";
		const requestedModels: string[] = [];
		session = buildModelSession({
			model,
			// Far more throws than maxRetries: an unbounded loop would consume them all.
			responses: Array.from({ length: 10 }, () => ({ throw: timeoutMessage })),
			settingsOverrides: { "retry.maxRetries": 2 },
			requestedModels,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("tiny prompt");
		await session.waitForIdle();

		// Bounded: 1 initial attempt + retry.maxRetries(2) retries = 3 requests, then surface.
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents.every(e => e.unbounded === false)).toBe(true);
		expect(requestedModels).toHaveLength(3);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("first event");
		expect(waitSpy).toHaveBeenCalled();
	});
	it("surfaces a Kimi Code first-event timeout after its continuous wait without replaying the request", async () => {
		const model = getBundledModel("kimi-code", "kimi-k2.5");
		if (!model) throw new Error("Expected bundled Kimi Code test model to exist");
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			model,
			errorMessage: "Provider stream timed out while waiting for the first event",
			requestedModels,
		});
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("slow Kimi request");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
		expect(lastAssistant(session).errorMessage).toContain("first event");
	});

	it("caps first-party first-event timeout retries at an explicit retry.maxRetries", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			// Isolates the retry cap from the silent-stall breaker (default 3).
			settingsOverrides: { "retry.maxRetries": 3, "retry.maxSilentTimeouts": 4 },
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("first-party first-event timeout");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(3);
		expect(retryStartEvents.every(e => e.unbounded === false)).toBe(true);
		expect(requestedModels).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("stops after consecutive first-event timeouts without output, inside the request budget", async () => {
		const requestedModels: string[] = [];
		session = buildSession({
			responses: [
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ throw: "Anthropic stream timed out while waiting for the first event" },
				{ content: ["never sent"] },
			],
			settingsOverrides: { "retry.maxRetries": 6 },
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		await session.prompt("silent provider");
		await session.waitForIdle();

		expect(requestedModels).toHaveLength(3);
		expect(lastAssistant(session).stopReason).toBe("error");
		expect(notices.some(message => message.includes("3 consecutive timeouts without any output"))).toBe(true);
	});
	it("retries provider stream first-event timeouts under a bare default config (single model)", async () => {
		// Regression: with a single default model and NO explicit retry.* keys,
		// a provider stream timeout used to fail the turn without retrying and
		// leave the agent idle. Clearly-transient stream timeouts must retry even
		// under the default configuration.
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config first-event timeout");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("retries a bare-default watchdog with an empty extension runner", async () => {
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ content: ["recovered"] },
			],
			requestedModels,
			extensionRunner: createExtensionRunner(),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config empty extension watchdog");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("does not replay a bare-default watchdog after a reasoning summary start hook participates", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let hookCalls = 0;
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = assistantMessage(
						model,
						[],
						"error",
						"Example Provider Watchdog stream stalled while waiting for the next event",
					);
					stream.push({ type: "start", partial: failure });
					stream.push({ type: "reasoning_summary_start", contentIndex: 0, partial: failure });
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"reasoning_summary_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config reasoning summary start watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(streamCalls).toBe(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not replay a bare-default watchdog after an extension hook participates", async () => {
		let hookCalls = 0;
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ content: ["should-not-reach"] },
			],
			requestedModels,
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"agent_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config extension hook watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("does not replay bare-default watchdogs after provider lifecycle handlers participate", async () => {
		for (const eventType of ["context", "before_provider_request", "after_provider_response"] as const) {
			let hookCalls = 0;
			const requestedModels: string[] = [];
			session = buildBareRetrySession({
				responses: [
					{
						throw: "Example Provider Watchdog stream timed out while waiting for the first event",
						...(eventType === "after_provider_response" ? { responseHeaders: { "x-request-id": "test" } } : {}),
					},
					{ content: ["should-not-reach"] },
				],
				requestedModels,
				emitProviderPayload: eventType === "before_provider_request",
				extensionRunner: createExtensionRunner(
					new Map([
						[
							eventType,
							[
								async () => {
									hookCalls++;
								},
							],
						],
					]),
				),
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt(`bare-config ${eventType} lifecycle watchdog`);
			await session.waitForIdle();

			expect(hookCalls).toBe(1);
			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	});
	it("does not replay a second bare-default watchdog after auto_retry_start handlers participate", async () => {
		let hookCalls = 0;
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ throw: "Example Provider Watchdog stream timed out while waiting for the first event" },
				{ content: ["should-not-reach"] },
			],
			requestedModels,
			extensionRunner: createExtensionRunner(
				new Map([
					[
						"auto_retry_start",
						[
							async () => {
								hookCalls++;
							},
						],
					],
				]),
			),
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config auto-retry lifecycle watchdog");
		await session.waitForIdle();

		expect(hookCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("retries provider stream idle stalls under a bare default config (single model)", async () => {
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [
				{ throw: "Anthropic stream stalled while waiting for the next event" },
				{ content: ["recovered"] },
			],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		await session.prompt("bare-config idle stall");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(requestedModels).toHaveLength(2);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("fails closed on structured watchdog facts under bare defaults", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = buildBareStreamingSession({
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const empty = assistantMessage(
						model,
						[],
						"error",
						"Example Provider Watchdog stream timed out while waiting for the first event",
					);
					empty.transportFailure = { kind: "transport", status: 503 };
					stream.push({ type: "start", partial: empty });
					stream.push({ type: "error", reason: "error", error: empty });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config unsafe watchdog");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(lastAssistant(session).stopReason).toBe("error");
	});
	it("continues a stalled visible text answer on the same model without deleting or re-emitting it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const stall = "Anthropic stream stalled while waiting for the next event";
		const contexts: Array<Array<{ role: string; text: string }>> = [];
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: (_model, context) => {
				streamCalls++;
				contexts.push(
					context.messages.map(message => ({
						role: message.role,
						text:
							typeof message.content === "string"
								? message.content
								: message.content
										.map(block => (block.type === "text" ? block.text : `[${block.type}]`))
										.join(""),
					})),
				);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const empty = assistantMessage(model, [], "error", stall);
						const visible = assistantMessage(
							model,
							[{ type: "text", text: "Three findings: one," }],
							"error",
							stall,
						);
						stream.push({ type: "start", partial: empty });
						stream.push({ type: "text_start", contentIndex: 0, partial: empty });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "Three findings: one,", partial: visible });
						stream.push({ type: "error", reason: "error", error: visible });
						return;
					}
					const done = assistantMessage(model, [{ type: "text", text: " two, three." }], "stop");
					const opening = assistantMessage(model, [], "stop");
					stream.push({ type: "start", partial: opening });
					stream.push({ type: "text_start", contentIndex: 0, partial: opening });
					stream.push({ type: "text_delta", contentIndex: 0, delta: " two, three.", partial: done });
					stream.push({ type: "done", reason: "stop", message: done });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);
		const deltas: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("report");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents.at(-1)?.success).toBe(true);
		// Each delta was shown exactly once: nothing deleted, nothing re-emitted.
		expect(deltas).toEqual(["Three findings: one,", " two, three."]);
		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants.map(message => message.content)).toEqual([
			[{ type: "text", text: "Three findings: one," }],
			[{ type: "text", text: " two, three." }],
		]);
		// The continuation request keeps the preserved prefix plus one instruction.
		const resent = contexts[1]!;
		expect(resent.at(-2)).toEqual({ role: "assistant", text: "Three findings: one," });
		expect(resent.at(-1)?.role).toBe("user");
		expect(resent.at(-1)?.text).toContain("Continue directly from where it stops");
		expect(resent.filter(message => message.text.includes("Continue directly"))).toHaveLength(1);
		// The checkpoint is durable session state, not model context.
		const entries = session.sessionManager.getEntries();
		expect(entries.some(entry => entry.type === "custom" && entry.customType === "recovery_checkpoint")).toBe(true);
	});
	it("pauses instead of continuing when the visible tail contains a tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const stall = "Anthropic stream stalled while waiting for the next event";
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(
						model,
						[
							{ type: "text", text: "Writing the file" },
							{ type: "toolCall", id: "partial-call", name: "write", arguments: {} },
						],
						"error",
						stall,
					);
					stream.push({ type: "start", partial });
					stream.push({ type: "error", reason: "error", error: partial });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("unsafe tail");
		await session.waitForIdle();

		expect(streamCalls).toBe(1);
		expect(retryStartEvents).toHaveLength(0);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(true);
	});
	it("recovers a bare-default watchdog after a completed tool without re-running the tool", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const toolCall: ToolCall = { type: "toolCall", id: "counted-tool-call", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real executions for replay-safety coverage",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "counted result" }] };
			},
		};
		session = buildBareStreamingSession({
			tools: [countedTool],
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 1) {
						const response = assistantMessage(model, [toolCall], "toolUse");
						stream.push({ type: "start", partial: response });
						stream.push({ type: "done", reason: "toolUse", message: response });
						return;
					}
					if (streamCalls === 2) {
						const failure = assistantMessage(
							model,
							[],
							"error",
							"Example Provider Watchdog stream timed out while waiting for the first event",
						);
						stream.push({ type: "start", partial: failure });
						stream.push({ type: "error", reason: "error", error: failure });
						return;
					}
					const done = assistantMessage(model, [{ type: "text", text: "finished" }], "stop");
					stream.push({ type: "start", partial: done });
					stream.push({ type: "done", reason: "stop", message: done });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("real counted tool watchdog");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toHaveLength(1);
		expect(streamCalls).toBe(3);
		expect(retryStartEvents).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});
	it("gives an active cancel-and-submit replacement a clean retry epoch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const originalStarted = Promise.withResolvers<void>();
		const originalAborted = Promise.withResolvers<void>();
		const originalStream = new AssistantMessageEventStream();
		let streamCalls = 0;
		session = buildBareStreamingSession({
			streamFn: (_requestedModel, _context, options) => {
				streamCalls++;
				if (streamCalls === 1) {
					queueMicrotask(() => {
						originalStream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
						originalStarted.resolve();
						options?.signal?.addEventListener(
							"abort",
							() => {
								originalAborted.resolve();
								const aborted = assistantMessage(model, [], "aborted", "Aborted");
								originalStream.push({ type: "error", reason: "aborted", error: aborted });
							},
							{ once: true },
						);
					});
					return originalStream;
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (streamCalls === 2) {
						const failure = assistantMessage(
							model,
							[],
							"error",
							"Example Provider Watchdog stream timed out while waiting for the first event",
						);
						stream.push({ type: "start", partial: failure });
						stream.push({ type: "error", reason: "error", error: failure });
						return;
					}
					const recovered = assistantMessage(model, [{ type: "text", text: "replacement recovered" }], "stop");
					stream.push({ type: "start", partial: recovered });
					stream.push({ type: "done", reason: "stop", message: recovered });
				});
				return stream;
			},
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents, retryEndEvents } = track(session);

		const originalPrompt = session.prompt("original");
		await originalStarted.promise;
		expect(await session.cancelAndSubmit("replacement")).toEqual({ kind: "submitted" });
		await originalAborted.promise;
		await originalPrompt;
		await session.waitForIdle();
		originalStream.push({
			type: "done",
			reason: "stop",
			message: assistantMessage(model, [{ type: "text", text: "late original" }], "stop"),
		});
		await Promise.resolve();

		expect(streamCalls).toBe(3);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.agent.state.messages.some(message => JSON.stringify(message).includes("late original"))).toBe(
			false,
		);
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "replacement recovered" }]);
	});
	it("fails closed on non-canonical watchdog prose under bare defaults", async () => {
		const nearMisses = [
			"stream timed out while waiting for the first event",
			"Error: Provider stream timed out while waiting for the first event",
			"Provider stream timed out while waiting for the first event.",
			"Provider stream timeout waiting for first event",
		];
		for (const errorMessage of nearMisses) {
			const requestedModels: string[] = [];
			session = buildBareRetrySession({
				responses: [{ throw: errorMessage }, { content: ["should-not-reach"] }],
				requestedModels,
			});
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { retryStartEvents } = track(session);

			await session.prompt("bare-config watchdog near miss");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(0);
			expect(requestedModels).toHaveLength(1);
			expect(lastAssistant(session).stopReason).toBe("error");
			await session.dispose();
			session = undefined;
		}
	});

	it("still fails closed on generic unknown errors under a bare default config", async () => {
		// The fix is scoped to clearly-transient failures. Generic unknown
		// provider errors preserve the historical fail-closed behavior when no
		// explicit retry.* settings opt into the resilient legacy retry path.
		const requestedModels: string[] = [];
		session = buildBareRetrySession({
			responses: [{ throw: "some unexpected provider explosion" }, { content: ["should-not-reach"] }],
			requestedModels,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { retryStartEvents } = track(session);

		await session.prompt("bare-config unknown error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		expect(requestedModels).toHaveLength(1);
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("never continues signed or redacted thinking tails after public text", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const privateBlocks: AssistantMessage["content"][number][] = [
			{ type: "thinking", thinking: "private", thinkingSignature: "immutable-signature" },
			{ type: "redactedThinking", data: "opaque-data" },
		];
		for (const privateBlock of privateBlocks) {
			let requests = 0;
			session = buildBareStreamingSession({
				streamFn: () => {
					requests++;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const partial = assistantMessage(
							model,
							[privateBlock, { type: "text", text: "preserved" }],
							"error",
							"Anthropic stream stalled while waiting for the next event",
						);
						stream.push({ type: "start", partial });
						stream.push({ type: "error", reason: "error", error: partial });
					});
					return stream;
				},
			});
			await session.prompt("signed-tail safety");
			await session.waitForIdle();
			expect(requests).toBe(1);
			expect(lastAssistant(session).content).toEqual([privateBlock, { type: "text", text: "preserved" }]);
			await session.dispose();
			session = undefined;
		}
	});

	it("refuses a visible continuation when checkpoint flush fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let requests = 0;
		session = buildBareStreamingSession({
			streamFn: () => {
				requests++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = assistantMessage(
						model,
						[{ type: "text", text: "prefix" }],
						"error",
						"Anthropic stream stalled while waiting for the next event",
					);
					stream.push({ type: "start", partial });
					stream.push({ type: "error", reason: "error", error: partial });
				});
				return stream;
			},
		});
		const ensure = vi.spyOn(session.sessionManager, "ensureOnDisk");
		const originalFlush = session.sessionManager.flush.bind(session.sessionManager);
		vi.spyOn(session.sessionManager, "flush").mockImplementation(async () => {
			const marker = session!.sessionManager
				.getBranch()
				.findLast(entry => entry.type === "custom" && entry.customType === "recovery_checkpoint");
			if (marker?.type === "custom" && (marker.data as { state?: string })?.state === "recovering")
				throw new Error("disk failure");
			await originalFlush();
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		await session.prompt("checkpoint failure");
		await session.waitForIdle();
		expect(requests).toBe(1);
		expect(ensure).toHaveBeenCalled();
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "prefix" }]);
	});

	it("does not re-execute a completed call ID returned by a later model step", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let requests = 0;
		let toolRuns = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real effects",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "saved" }] };
			},
		};
		session = buildBareStreamingSession({
			tools: [countedTool],
			streamFn: () => {
				requests++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response = assistantMessage(
						model,
						[{ type: "toolCall", id: "confirmed-write", name: "counted", arguments: {} }],
						"toolUse",
					);
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "toolUse", message: response });
				});
				return stream;
			},
		});
		await session.prompt("one write only");
		await session.waitForIdle();
		expect(requests).toBe(2);
		expect(toolRuns).toBe(1);
		expect(lastAssistant(session).errorCode).toBe("tool_call_identity_reentry");
		expect(
			session.agent.state.messages.filter(
				message => message.role === "toolResult" && message.toolCallId === "confirmed-write",
			),
		).toHaveLength(1);
	});

	it("runs consecutive tool calls whose provider left the call id blank", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let requests = 0;
		let toolRuns = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts real effects",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "saved" }] };
			},
		};
		session = buildBareStreamingSession({
			tools: [countedTool],
			streamFn: () => {
				requests++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response =
						requests <= 2
							? assistantMessage(
									model,
									[{ type: "toolCall", id: "", name: "counted", arguments: {} }],
									"toolUse",
								)
							: assistantMessage(model, [{ type: "text", text: "done" }], "stop");
					stream.push({ type: "start", partial: response });
					stream.push({
						type: "done",
						reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
						message: response,
					});
				});
				return stream;
			},
		});
		await session.prompt("two unnamed writes");
		await session.waitForIdle();
		expect(requests).toBe(3);
		expect(toolRuns).toBe(2);
		expect(lastAssistant(session).errorCode).toBeUndefined();
	});

	it("does not truncate a Retry-After floor beyond the remaining deadline", async () => {
		const requestedModels: string[] = [];
		session = buildStatusErrorSession({
			errorMessage: "503 service unavailable",
			errorStatus: 503,
			transportFailure: { kind: "transport", status: 503, headers: { "retry-after-ms": "1200000" } },
			recoveredContent: "must not be requested",
			requestedModels,
			settingsOverrides: { "retry.maxRetries": 1, "retry.maxDelayMs": 60_000 },
		});
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		await session.prompt("respect provider wait floor");
		await session.waitForIdle();
		expect(requestedModels).toHaveLength(1);
		expect(wait).not.toHaveBeenCalled();
		expect(lastAssistant(session).stopReason).toBe("error");
	});

	it("persists in_flight before credential lookup and first inference, then completed after success", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const phases: string[] = [];
		session = buildBareStreamingSession({
			sessionManager: manager,
			streamFn: async () => {
				const file = manager.getSessionFile();
				if (!file) throw new Error("Missing checkpoint file");
				const contents = await Bun.file(file).text();
				expect(contents).toContain('"state":"in_flight"');
				phases.push("inference");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const done = assistantMessage(model, [{ type: "text", text: "accepted" }], "stop");
					stream.push({ type: "start", partial: done });
					stream.push({ type: "done", reason: "stop", message: done });
				});
				return stream;
			},
		});
		vi.spyOn(session.agent, "getApiKey").mockImplementation(async () => {
			const file = manager.getSessionFile();
			if (!file) throw new Error("Missing checkpoint file");
			expect(await Bun.file(file).text()).toContain('"state":"in_flight"');
			phases.push("credentials");
			return "test-key";
		});
		await session.prompt("durable first admission");
		await session.waitForIdle();
		expect(phases).toEqual(["credentials", "inference"]);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing completion file");
		expect(await Bun.file(file).text()).toContain('"state":"completed"');
	});

	it("lets a new prompt run a full tool loop after hydrating an interrupted checkpoint", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("recovery_checkpoint", { version: 1, state: "in_flight", stepId: "lost-step" });
		const toolCall: ToolCall = { type: "toolCall", id: "hydrated-tool-call", name: "counted", arguments: {} };
		let toolRuns = 0;
		let streamCalls = 0;
		const countedTool: AgentTool = {
			name: "counted",
			label: "Counted",
			description: "Counts executions after hydration",
			parameters: z.object({}),
			execute: async () => {
				toolRuns++;
				return { content: [{ type: "text" as const, text: "counted result" }] };
			},
		};
		session = buildBareStreamingSession({
			tools: [countedTool],
			sessionManager: manager,
			streamFn: () => {
				streamCalls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const response =
						streamCalls === 1
							? assistantMessage(model, [toolCall], "toolUse")
							: assistantMessage(model, [{ type: "text", text: "finished" }], "stop");
					stream.push({ type: "start", partial: response });
					stream.push({
						type: "done",
						reason: response.stopReason === "toolUse" ? "toolUse" : "stop",
						message: response,
					});
				});
				return stream;
			},
		});

		await session.prompt("explicit resume after interruption");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(streamCalls).toBe(2);
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("never rebinds a retained old admission hook to a successor turn", async () => {
		const retained: Array<NonNullable<Parameters<StreamFn>[2]>["onUpstreamRequest"]> = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = buildBareStreamingSession({
			streamFn: (_model, _context, options) => {
				retained.push(options?.onUpstreamRequest);
				options?.onUpstreamRequest?.("inference");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const done = assistantMessage(model, [{ type: "text", text: "done" }], "stop");
					stream.push({ type: "done", reason: "stop", message: done });
				});
				return stream;
			},
		});
		await session.prompt("first owner");
		await session.waitForIdle();
		expect(retained[0]).toBeDefined();
		expect(() => retained[0]?.("resend")).toThrow("Recovery was cancelled before another upstream request");
		await session.prompt("successor owner");
		await session.waitForIdle();
		expect(retained).toHaveLength(2);
		expect(() => retained[0]?.("inference")).toThrow("Recovery was cancelled before another upstream request");
	});
});
