import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentContext } from "@sayknow-cli/agent-core";
import type { AssistantMessage, Context, Model, ProviderSessionState, Usage } from "@sayknow-cli/ai";
import {
	prewarmOpenAICodexResponses,
	streamOpenAICodexResponses,
} from "@sayknow-cli/ai/providers/openai-codex-responses";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { loadExtensions } from "@sayknow-cli/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@sayknow-cli/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { getLatestCompactionEntry, SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";
import { createAppendOnlyContextManager } from "../src/append-only-mode";

const originalFetch = global.fetch;
const originalWebSocket = global.WebSocket;

function codexSseResponse(ordinal: number): Response {
	const text = `wire answer ${ordinal}`;
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${ordinal}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${ordinal}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.done",
			response: {
				id: `resp_${ordinal}`,
				status: "completed",
				usage: {
					input_tokens: maintenanceResponseInputTokens,
					output_tokens: 3,
					total_tokens: maintenanceResponseInputTokens + 3,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"x-codex-turn-state": `turn-${ordinal}`,
			"x-models-etag": `etag-${ordinal}`,
		},
	});
}

class MaintenanceCodexWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = MaintenanceCodexWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;
	handshakeHeaders: Record<string, string>;

	constructor(
		readonly url: string,
		readonly options?: { headers?: Record<string, string> },
	) {
		const ordinal = maintenanceSockets.length + 1;
		this.handshakeHeaders = {
			"x-codex-turn-state": `turn-${ordinal}`,
			"x-models-etag": `etag-${ordinal}`,
		};
		maintenanceSockets.push(this);
		if (!maintenanceHoldSocketOpen) {
			queueMicrotask(() => this.open());
		}
	}

	open(): void {
		this.readyState = MaintenanceCodexWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	send(data: string): void {
		const request = JSON.parse(data) as Record<string, unknown>;
		maintenanceWireRequests.push(request);
		const ordinal = maintenanceWireRequests.length;
		if (maintenanceHeldOrdinal === ordinal) {
			maintenanceHeldSocket = this;
			maintenanceHeldRequest.resolve();
			return;
		}
		queueMicrotask(() => this.complete(ordinal));
	}

	close(): void {
		if (this.readyState === MaintenanceCodexWebSocket.CLOSED) return;
		this.readyState = MaintenanceCodexWebSocket.CLOSED;
		this.onclose?.({ code: 1000 } as CloseEvent);
	}

	complete(ordinal: number): void {
		const text = `wire answer ${ordinal}`;
		for (const event of [
			{
				type: "response.output_item.added",
				item: { type: "message", id: `msg_${ordinal}`, role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
			{ type: "response.output_text.delta", delta: text },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: `msg_${ordinal}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text }],
				},
			},
			{
				type: "response.done",
				response: {
					id: `resp_${ordinal}`,
					status: "completed",
					usage: {
						input_tokens: maintenanceResponseInputTokens,
						output_tokens: 3,
						total_tokens: maintenanceResponseInputTokens + 3,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]) {
			this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
		}
	}
}

let maintenanceSockets: MaintenanceCodexWebSocket[] = [];
let maintenanceWireRequests: Array<Record<string, unknown>> = [];
let maintenanceHeldOrdinal: number | undefined;
let maintenanceHeldSocket: MaintenanceCodexWebSocket | undefined;
let maintenanceHoldSocketOpen = false;
let maintenanceResponseInputTokens = 300_000;
let maintenanceHeldRequest = Promise.withResolvers<void>();

/**
 * Outcome-contract coverage for cooperative mid-run context maintenance
 * (issue #2035, `AgentSession#runMidRunMaintenance` via the test seam). The
 * decision anchors on the last assistant's `usage.totalTokens` plus trailing
 * tool/steering deltas; the action reuses prune → promote → compact and returns
 * one of `not-needed | pruned | compacted | promoted | failed | aborted`.
 */
describe("AgentSession mid-run maintenance outcomes", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const THRESHOLD = 100_000;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-midrun-maintenance-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		maintenanceSockets = [];
		maintenanceWireRequests = [];
		maintenanceHeldOrdinal = undefined;
		maintenanceHeldSocket = undefined;
		maintenanceHoldSocketOpen = false;
		maintenanceResponseInputTokens = 300_000;
		maintenanceHeldRequest = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		global.fetch = originalFetch;
		global.WebSocket = originalWebSocket;
		(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = undefined;
		(globalThis as { __midrunCompactEntered?: () => void }).__midrunCompactEntered = undefined;
	});

	function codexModel(contextWindow: number): Model {
		const model = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!model) throw new Error("Expected bundled openai-codex model to exist");
		return { ...model, contextWindow, maxTokens: 32_768 };
	}

	async function shortCircuitExtensionRunner(sessionManager: SessionManager): Promise<ExtensionRunner> {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\tconst gate = globalThis.__midrunCompactGate;",
				"\t\tglobalThis.__midrunCompactEntered?.();",
				'\t\tif (gate) await Promise.race([gate, new Promise(resolve => event.signal.addEventListener("abort", resolve, { once: true }))]);',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted summary",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		return new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	function usage(totalTokens: number, input = totalTokens, output = 0): Usage {
		return {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function assistant(model: Model, u: Usage, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: u,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
	}

	async function buildSession(options: {
		contextWindow?: number;
		shortCircuit?: boolean;
		settings?: Record<string, unknown>;
	}): Promise<AgentSession> {
		const model = codexModel(options.contextWindow ?? 200_000);
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = options.shortCircuit ? await shortCircuitExtensionRunner(sessionManager) : undefined;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": THRESHOLD,
			"contextPromotion.enabled": false,
			...options.settings,
		});
		return new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
	}

	/** Seed the agent state + session branch with message_end events, then settle persistence. */
	async function seed(s: AgentSession, messages: readonly unknown[]): Promise<void> {
		for (const message of messages) {
			s.agent.emitExternalEvent({ type: "message_end", message: message as never });
		}
		await Bun.sleep(10);
	}

	/**
	 * Seed a multi-turn conversation whose older turns are summarizable, so
	 * prepareCompaction returns a real preparation. The last assistant carries
	 * `finalUsageTotal` (the mid-run estimate anchor). Pair with a low
	 * `compaction.keepRecentTokens` so the small-content branch still compacts.
	 */
	async function seedCompactableConversation(s: AgentSession, finalUsageTotal: number): Promise<void> {
		const m = s.model!;
		await seed(s, [
			{ role: "user", content: "first request: analyze the earlier work in detail", timestamp: Date.now() },
			assistant(m, usage(1_000), "earlier response one with some content"),
			{ role: "user", content: "second request: continue the analysis thoroughly", timestamp: Date.now() },
			assistant(m, usage(1_000), "earlier response two with more content"),
			{ role: "user", content: "third request: keep going with the plan", timestamp: Date.now() },
			assistant(m, usage(finalUsageTotal), "final response near the window"),
		]);
	}

	function contextOf(s: AgentSession): AgentContext {
		return { systemPrompt: s.state.systemPrompt, messages: s.messages, tools: [] };
	}

	async function waitFor(predicate: () => boolean): Promise<void> {
		const deadline = Date.now() + 1_000;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
			await Bun.sleep(1);
		}
	}

	it("estimates on last-assistant totalTokens, not the prompt-only anchor", async () => {
		session = await buildSession({});
		const model = session.model!;
		// input(prompt-only)=50k but totalTokens(input+output)=100k. The mid-run
		// estimate must use totalTokens, so it cannot be near the 50k prompt anchor.
		const estimate = session.estimateMidRunContextTokensForTests([
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(100_000, 50_000, 50_000)),
		]);
		expect(estimate).toBeGreaterThanOrEqual(100_000);
	});

	it("adds trailing tool-result deltas to the totalTokens anchor", async () => {
		session = await buildSession({});
		const model = session.model!;
		const base = [{ role: "user", content: "hi", timestamp: Date.now() } as never, assistant(model, usage(90_000))];
		const withTrailing = [
			...base,
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(40_000) }],
				timestamp: Date.now(),
			} as never,
		];
		const baseEstimate = session.estimateMidRunContextTokensForTests(base);
		const trailingEstimate = session.estimateMidRunContextTokensForTests(withTrailing);
		expect(baseEstimate).toBe(90_000);
		expect(trailingEstimate).toBeGreaterThan(baseEstimate);
	});

	it("returns not-needed below the threshold", async () => {
		session = await buildSession({});
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(10_000)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});

	it("runs the emergency floor when model contextWindow metadata is unavailable", async () => {
		session = await buildSession({
			contextWindow: 0,
			shortCircuit: true,
			settings: { "compaction.keepRecentTokens": 10 },
		});
		await seedCompactableConversation(session, 1_000);
		session.setResourceSampler(() => ({
			heapUsedBytes: Number.MAX_SAFE_INTEGER,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
		}));

		await session.runPrePromptContextCheckForTests();
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).not.toBeNull();
	});

	it.each([
		["disabled", { "compaction.enabled": false }],
		["off", { "compaction.strategy": "off" }],
	] as const)("forces transcript emergency compaction when settings are %s", async (_label, settings) => {
		session = await buildSession({
			shortCircuit: true,
			settings: { ...settings, "compaction.keepRecentTokens": 10 },
		});
		await seedCompactableConversation(session, 1_000);
		session.setResourceSampler(() => ({
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 48 * 1024 * 1024 + 1,
		}));

		await session.runPrePromptContextCheckForTests();
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).not.toBeNull();
	});

	it("rewrites exact live entries when transcript emergency compaction is skipped", async () => {
		session = await buildSession({ contextWindow: 0, shortCircuit: false });
		const rewriteSpy = vi.spyOn(session.sessionManager, "rewriteEntries").mockResolvedValue();
		session.setResourceSampler(() => ({
			heapUsedBytes: 0,
			providerBytes: 0,
			messageCount: 0,
			imageBytes: 0,
			transcriptFileBytes: 48 * 1024 * 1024 + 1,
		}));

		await session.runPrePromptContextCheckForTests();
		expect(rewriteSpy).toHaveBeenCalledTimes(1);
	});

	it("returns not-needed at exactly the threshold and maintains just past it", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD)),
		]);
		// shouldCompact is strictly greater-than, so exactly-at-threshold does not maintain.
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");

		const over = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(over, THRESHOLD + 5_000);
		expect(
			await over.runMidRunMaintenanceForTests({
				systemPrompt: over.state.systemPrompt,
				messages: over.messages,
				tools: [],
			}),
		).toBe("compacted");
		await over.dispose();
	});

	it("returns not-needed when auto maintenance is disabled or strategy is off", async () => {
		session = await buildSession({ settings: { "compaction.strategy": "off" } });
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD * 3)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});

	it("compaction closes every nested Codex epoch, even when one close throws or maps alias", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		const closes: string[] = [];
		const oldestSuspendedMap = session.providerSessionState;
		oldestSuspendedMap.set("openai-codex-responses", {
			close: () => closes.push("oldest"),
		} satisfies ProviderSessionState);
		const unrelatedState = { close: vi.fn() } satisfies ProviderSessionState;
		oldestSuspendedMap.set("anthropic-messages", unrelatedState);
		session.beginTemporaryProviderSessionScope("context-promotion");
		const innerSuspendedMap = session.providerSessionState;
		innerSuspendedMap.set("openai-codex-responses", {
			close: () => {
				closes.push("throwing");
				throw new Error("expected close failure");
			},
		} satisfies ProviderSessionState);
		session.beginTemporaryProviderSessionScope("context-promotion");
		const activeMap = session.providerSessionState;
		activeMap.set("openai-codex-responses", {
			close: () => closes.push("active"),
		} satisfies ProviderSessionState);
		// The agent aliases the active map. The rewrite fence must de-duplicate it.
		expect(session.agent.providerSessionState).toBe(activeMap);

		await seedCompactableConversation(session, THRESHOLD * 3);
		const before = getLatestCompactionEntry(session.sessionManager.getBranch());
		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));

		expect(outcome).toBe("compacted");
		const after = getLatestCompactionEntry(session.sessionManager.getBranch());
		expect(after).not.toBeNull();
		expect(after?.id).not.toBe(before?.id ?? null);
		// Regression owner: the pre-fix fence closed only the active map. Restoring
		// either suspended scope then resurrected its stale Codex response epoch.
		// This production compaction path must therefore empty every reachable map;
		// it fails against that old active-map-only boundary.
		expect(closes.sort()).toEqual(["active", "oldest", "throwing"]);
		expect(oldestSuspendedMap.has("openai-codex-responses")).toBe(false);
		expect(innerSuspendedMap.has("openai-codex-responses")).toBe(false);
		expect(activeMap.has("openai-codex-responses")).toBe(false);
		expect(oldestSuspendedMap.get("anthropic-messages")).toBe(unrelatedState);
		expect(unrelatedState.close).not.toHaveBeenCalled();

		const repeatedCloses: string[] = [];
		oldestSuspendedMap.set("openai-codex-responses", { close: () => repeatedCloses.push("oldest") });
		innerSuspendedMap.set("openai-codex-responses", { close: () => repeatedCloses.push("inner") });
		activeMap.set("openai-codex-responses", { close: () => repeatedCloses.push("active") });
		await seedCompactableConversation(session, THRESHOLD * 3);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("compacted");
		expect(repeatedCloses.sort()).toEqual(["active", "inner", "oldest"]);
		expect(oldestSuspendedMap.has("openai-codex-responses")).toBe(false);
		expect(innerSuspendedMap.has("openai-codex-responses")).toBe(false);
		expect(activeMap.has("openai-codex-responses")).toBe(false);
	});

	it.each([
		["http", "off"],
		["http", "on"],
		["http", "auto"],
		["websocket", "off"],
		["websocket", "on"],
		["websocket", "auto"],
	] as const)("rebases the first actual %s request after production compaction (append-only=%s)", async (transport, appendOnlyMode) => {
		session = await buildSession({
			shortCircuit: true,
			settings: {
				"compaction.keepRecentTokens": 200,
				"provider.appendOnlyContext": appendOnlyMode,
				"providers.openaiWebsockets": transport === "websocket" ? "on" : "off",
			},
		});
		const model = {
			...session.model!,
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: transport === "websocket",
		} as Model<"openai-codex-responses">;
		await session.setModel(model);
		expect(Boolean(session.agent.appendOnlyContext)).toBe(appendOnlyMode === "on");
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const apiKey = `aaa.${tokenPayload}.bbb`;
		const httpHeaders: Headers[] = [];
		if (transport === "websocket") {
			global.WebSocket = MaintenanceCodexWebSocket as unknown as typeof WebSocket;
			global.fetch = vi.fn(async () => {
				throw new Error("unexpected SSE fallback");
			}) as unknown as typeof fetch;
		} else {
			global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				maintenanceWireRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				httpHeaders.push(init?.headers instanceof Headers ? init.headers : new Headers(init?.headers));
				return codexSseResponse(maintenanceWireRequests.length);
			}) as unknown as typeof fetch;
		}

		const removedPrefix = `OLD_PREFIX_SENTINEL_${"x".repeat(12_000)}`;
		const keptSentinel = "KEPT_HISTORY_SENTINEL";
		const toolCallSentinel = "PAIRED_TOOL_CALL_SENTINEL";
		const toolResultSentinel = "PAIRED_TOOL_RESULT_SENTINEL";
		const steeringOne = "DISTINCT_STEERING_ONE";
		const steeringTwo = "DISTINCT_STEERING_TWO";
		const systemSentinel = "SYSTEM_INSTRUCTIONS_SENTINEL";
		const toolDefinitionSentinel = "TOOL_DEFINITION_SENTINEL";
		const selectedModel = session.model!;
		await seed(session, [
			{ role: "user", content: removedPrefix, timestamp: Date.now() },
			assistant(selectedModel, usage(1_000), "old answer"),
			{ role: "user", content: "current request", timestamp: Date.now() + 1 },
			{
				...assistant(selectedModel, usage(THRESHOLD * 3)),
				content: [
					{ type: "text", text: `${keptSentinel}_${"k".repeat(2_000)}` },
					{
						type: "toolCall",
						id: "paired-call-id",
						name: "sentinel_tool",
						arguments: { marker: toolCallSentinel },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "paired-call-id",
				toolName: "sentinel_tool",
				content: [{ type: "text", text: toolResultSentinel }],
				timestamp: Date.now() + 2,
			},
			{ role: "user", content: steeringOne, timestamp: Date.now() + 3 },
		]);
		const pairedAssistantEntry = session.sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return false;
			return entry.message.content.some(content => content.type === "toolCall" && content.id === "paired-call-id");
		});
		if (!pairedAssistantEntry) throw new Error("Expected paired assistant entry");

		const toProviderContext = async (): Promise<Context> => {
			const context: Context = {
				systemPrompt: [systemSentinel],
				messages: await session.convertMessagesToLlm(session.messages),
				tools: [
					{
						name: "sentinel_tool",
						description: toolDefinitionSentinel,
						parameters: z.object({ marker: z.string() }),
					},
				],
			};
			const manager = session.agent.appendOnlyContext;
			if (!manager) return context;
			manager.syncMessages([...context.messages]);
			return manager.build(context as AgentContext, { intentTracing: false }) as Context;
		};
		const send = async (): Promise<AssistantMessage> =>
			streamOpenAICodexResponses(model, await toProviderContext(), {
				apiKey,
				sessionId: `maintenance-wire-${transport}-${appendOnlyMode}`,
				preferWebsockets: transport === "websocket",
				providerSessionState: session.providerSessionState,
			}).result();

		const initialResult = await send();
		await seed(session, [initialResult, { role: "user", content: steeringTwo, timestamp: Date.now() + 4 }]);
		await send();
		const normalContinuationRequest = maintenanceWireRequests[1];
		expect(normalContinuationRequest).toBeDefined();
		if (transport === "websocket") {
			expect(normalContinuationRequest?.previous_response_id).toBe("resp_1");
		} else {
			expect(httpHeaders[1]?.get("x-codex-turn-state")).toBe("turn-1");
			expect(httpHeaders[1]?.get("x-models-etag")).toBe("etag-1");
		}

		const beforeRewrite = JSON.stringify(maintenanceWireRequests[0]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("compacted");
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())?.firstKeptEntryId).toBe(
			pairedAssistantEntry.id,
		);
		const rewrittenResult = await send();
		const rewrittenRequest = maintenanceWireRequests[2];
		expect(rewrittenRequest).toBeDefined();
		expect(rewrittenRequest?.previous_response_id).toBeUndefined();
		const rewrittenSerialized = JSON.stringify(rewrittenRequest);
		for (const stale of [removedPrefix, "resp_1", "msg_1", "turn-1", "etag-1", "previous_response_id"]) {
			expect(rewrittenSerialized).not.toContain(stale);
		}
		const retainedSemantics = [
			systemSentinel,
			toolDefinitionSentinel,
			"compacted summary",
			keptSentinel,
			toolCallSentinel,
			toolResultSentinel,
			steeringOne,
			steeringTwo,
		] as const;
		const retainedCounts = Object.fromEntries(
			retainedSemantics.map(sentinel => [sentinel, rewrittenSerialized.split(sentinel).length - 1]),
		);
		expect(retainedCounts).toEqual(Object.fromEntries(retainedSemantics.map(sentinel => [sentinel, 1])));
		expect(rewrittenSerialized.length).toBeLessThanOrEqual(beforeRewrite.length * 0.5);
		if (transport === "websocket") {
			expect(maintenanceSockets).toHaveLength(2);
			expect(maintenanceSockets[1]?.options?.headers?.["x-codex-turn-state"]).toBeUndefined();
			expect(maintenanceSockets[1]?.options?.headers?.["x-models-etag"]).toBeUndefined();
		} else {
			expect(httpHeaders[2]?.get("x-codex-turn-state")).toBeNull();
			expect(httpHeaders[2]?.get("x-models-etag")).toBeNull();
		}

		await seed(session, [
			rewrittenResult,
			{ role: "user", content: "NORMAL_APPEND_AFTER_REWRITE", timestamp: Date.now() + 5 },
		]);
		await send();
		const resumedSerialized = JSON.stringify(maintenanceWireRequests[3]);
		if (transport === "websocket") {
			expect(maintenanceWireRequests[3]?.previous_response_id).toBe("resp_3");
			expect(maintenanceSockets).toHaveLength(2);
		} else {
			expect(resumedSerialized).toContain("wire answer 3");
			expect(resumedSerialized).toContain("NORMAL_APPEND_AFTER_REWRITE");
			expect(resumedSerialized).not.toContain("turn-1");
			expect(resumedSerialized).not.toContain("etag-1");
			expect(httpHeaders[3]?.get("x-codex-turn-state")).toBe("turn-3");
			expect(httpHeaders[3]?.get("x-models-etag")).toBe("etag-3");
		}
	});

	it("does not let a pre-rewrite in-flight websocket completion reclaim the fresh anchor", async () => {
		session = await buildSession({
			shortCircuit: true,
			settings: {
				"compaction.keepRecentTokens": 10,
				"provider.appendOnlyContext": "on",
				"providers.openaiWebsockets": "on",
			},
		});
		const model = {
			...session.model!,
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: true,
		} as Model<"openai-codex-responses">;
		session.agent.setModel(model);
		session.agent.setAppendOnlyContext(createAppendOnlyContextManager("openai-codex"));
		global.WebSocket = MaintenanceCodexWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("unexpected SSE fallback");
		}) as unknown as typeof fetch;
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const send = async () => {
			const context: Context = {
				systemPrompt: ["race system"],
				messages: await session.convertMessagesToLlm(session.messages),
				tools: [],
			};
			const manager = session.agent.appendOnlyContext;
			manager?.syncMessages([...context.messages]);
			return streamOpenAICodexResponses(
				model,
				manager ? (manager.build(context as AgentContext, { intentTracing: false }) as Context) : context,
				{
					apiKey: `aaa.${tokenPayload}.bbb`,
					sessionId: "maintenance-late-completion",
					preferWebsockets: true,
					streamMaxRetries: 0,
					requestMaxRetries: 0,
					providerSessionState: session.providerSessionState,
				},
			).result();
		};

		await seedCompactableConversation(session, THRESHOLD * 3);
		const baselineResult = await send();
		await seed(session, [
			baselineResult,
			{ role: "user", content: "pre-rewrite continuation", timestamp: Date.now() },
		]);
		maintenanceHeldOrdinal = 2;
		const oldInFlight = send();
		await maintenanceHeldRequest.promise;
		expect(maintenanceWireRequests[1]?.previous_response_id).toBe("resp_1");

		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("compacted");
		maintenanceHeldOrdinal = undefined;
		const freshBaselineResult = await send();
		expect(maintenanceWireRequests[2]?.previous_response_id).toBeUndefined();
		expect(maintenanceSockets).toHaveLength(2);

		// Deliberately deliver the detached request after the completed rewrite and
		// fresh baseline. Its resp_999 anchor must remain generation-stale.
		maintenanceHeldSocket?.complete(999);
		await oldInFlight;
		await seed(session, [
			freshBaselineResult,
			{ role: "user", content: "post-race continuation", timestamp: Date.now() + 1 },
		]);
		await send();
		expect(maintenanceWireRequests[3]?.previous_response_id).toBe("resp_3");
		expect(maintenanceWireRequests).toHaveLength(4);
		expect(maintenanceSockets).toHaveLength(2);
	});

	it("does not let a pre-rewrite in-flight HTTP completion reclaim the fresh epoch", async () => {
		session = await buildSession({
			shortCircuit: true,
			settings: {
				"compaction.keepRecentTokens": 10,
				"provider.appendOnlyContext": "on",
				"providers.openaiWebsockets": "off",
			},
		});
		const model = {
			...session.model!,
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: false,
		} as Model<"openai-codex-responses">;
		session.agent.setModel(model);
		session.agent.setAppendOnlyContext(createAppendOnlyContextManager("openai-codex"));
		const heldResponse = Promise.withResolvers<Response>();
		const heldRequestSent = Promise.withResolvers<void>();
		const requestHeaders: Headers[] = [];
		global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			maintenanceWireRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			requestHeaders.push(init?.headers instanceof Headers ? init.headers : new Headers(init?.headers));
			const ordinal = maintenanceWireRequests.length;
			if (ordinal === 2) {
				heldRequestSent.resolve();
				return heldResponse.promise;
			}
			return codexSseResponse(ordinal);
		}) as unknown as typeof fetch;
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const send = async () => {
			const context: Context = {
				systemPrompt: ["http race system"],
				messages: await session.convertMessagesToLlm(session.messages),
				tools: [],
			};
			const manager = session.agent.appendOnlyContext;
			manager?.syncMessages([...context.messages]);
			return streamOpenAICodexResponses(
				model,
				manager ? (manager.build(context as AgentContext, { intentTracing: false }) as Context) : context,
				{
					apiKey: `aaa.${tokenPayload}.bbb`,
					sessionId: "maintenance-http-late-completion",
					preferWebsockets: false,
					streamMaxRetries: 0,
					requestMaxRetries: 0,
					providerSessionState: session.providerSessionState,
				},
			).result();
		};

		try {
			await seedCompactableConversation(session, THRESHOLD * 3);
			const baselineResult = await send();
			await seed(session, [
				baselineResult,
				{ role: "user", content: "HTTP_PRE_REWRITE_CONTINUATION", timestamp: Date.now() },
			]);
			const oldInFlight = send();
			await heldRequestSent.promise;
			expect(JSON.stringify(maintenanceWireRequests[1])).toContain("HTTP_PRE_REWRITE_CONTINUATION");

			expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("compacted");
			const freshBaselineResult = await send();
			const freshBaselineSerialized = JSON.stringify(maintenanceWireRequests[2]);
			for (const stale of ["turn-1", "etag-1", "previous_response_id"]) {
				expect(freshBaselineSerialized).not.toContain(stale);
			}
			expect(requestHeaders[2]?.get("x-codex-turn-state")).toBeNull();
			expect(requestHeaders[2]?.get("x-models-etag")).toBeNull();

			heldResponse.resolve(codexSseResponse(999));
			await oldInFlight;
			await seed(session, [
				freshBaselineResult,
				{ role: "user", content: "HTTP_POST_RACE_CONTINUATION", timestamp: Date.now() + 1 },
			]);
			await send();
			const resumedSerialized = JSON.stringify(maintenanceWireRequests[3]);
			expect(resumedSerialized).toContain("wire answer 3");
			expect(resumedSerialized).toContain("HTTP_POST_RACE_CONTINUATION");
			expect(resumedSerialized).not.toContain("wire answer 999");
			expect(resumedSerialized).not.toContain("turn-1");
			expect(resumedSerialized).not.toContain("etag-1");
			expect(requestHeaders[3]?.get("x-codex-turn-state")).toBe("turn-3");
			expect(requestHeaders[3]?.get("x-models-etag")).toBe("etag-3");
			expect(maintenanceWireRequests).toHaveLength(4);
		} finally {
			heldResponse.resolve(codexSseResponse(999));
		}
	});

	it.each([
		["http", "off"],
		["http", "on"],
		["http", "auto"],
		["websocket", "off"],
		["websocket", "on"],
		["websocket", "auto"],
	] as const)("rebases the first actual %s request after production prune (append-only=%s)", async (transport, appendOnlyMode) => {
		maintenanceResponseInputTokens = THRESHOLD - 5_000;
		session = await buildSession({
			shortCircuit: true,
			settings: {
				"provider.appendOnlyContext": appendOnlyMode,
				"providers.openaiWebsockets": transport === "websocket" ? "on" : "off",
			},
		});
		const model = {
			...session.model!,
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: transport === "websocket",
		} as Model<"openai-codex-responses">;
		await session.setModel(model);
		expect(Boolean(session.agent.appendOnlyContext)).toBe(appendOnlyMode === "on");
		const httpHeaders: Headers[] = [];
		if (transport === "websocket") {
			global.WebSocket = MaintenanceCodexWebSocket as unknown as typeof WebSocket;
			global.fetch = vi.fn(async () => {
				throw new Error("unexpected SSE fallback");
			}) as unknown as typeof fetch;
		} else {
			global.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				maintenanceWireRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				httpHeaders.push(init?.headers instanceof Headers ? init.headers : new Headers(init?.headers));
				return codexSseResponse(maintenanceWireRequests.length);
			}) as unknown as typeof fetch;
		}
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const send = async () => {
			const context: Context = {
				systemPrompt: ["prune system"],
				messages: await session.convertMessagesToLlm(session.messages),
				tools: [],
			};
			const manager = session.agent.appendOnlyContext;
			manager?.syncMessages([...context.messages]);
			return streamOpenAICodexResponses(
				model,
				manager ? (manager.build(context as AgentContext, { intentTracing: false }) as Context) : context,
				{
					apiKey: `aaa.${tokenPayload}.bbb`,
					sessionId: `maintenance-prune-wire-${transport}-${appendOnlyMode}`,
					preferWebsockets: transport === "websocket",
					providerSessionState: session.providerSessionState,
				},
			).result();
		};
		const oldToolOutputs = [
			`PRUNED_OLD_TOOL_OUTPUT_ONE_${"x".repeat(120_000)}`,
			`PRUNED_OLD_TOOL_OUTPUT_TWO_${"y".repeat(120_000)}`,
			`PRUNED_OLD_TOOL_OUTPUT_THREE_${"z".repeat(120_000)}`,
		];
		await seed(session, [
			{ role: "user", content: "prune request", timestamp: Date.now() },
			...oldToolOutputs.map((output, index) => ({
				role: "toolResult" as const,
				toolCallId: `old-prune-call-${index + 1}`,
				toolName: "bash",
				content: [{ type: "text" as const, text: output }],
				timestamp: Date.now() + index + 1,
			})),
			{
				...assistant(model, usage(THRESHOLD + 1)),
				content: [
					{ type: "text", text: "prune anchor" },
					{
						type: "toolCall",
						id: "kept-prune-call",
						name: "noop",
						arguments: { marker: "KEPT_PRUNE_CALL" },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "kept-prune-call",
				toolName: "noop",
				content: [{ type: "text", text: "KEPT_PRUNE_RESULT" }],
				timestamp: Date.now() + 4,
			},
			{ role: "user", content: "PRUNE_STEERING_ONE", timestamp: Date.now() + 5 },
			{ role: "user", content: "PRUNE_STEERING_TWO", timestamp: Date.now() + 6 },
		]);

		const initialResult = await send();
		await seed(session, [
			initialResult,
			{ role: "user", content: `PRUNE_NORMAL_BEFORE_REWRITE_${"s".repeat(30_000)}`, timestamp: Date.now() + 7 },
		]);
		await send();
		if (transport === "websocket") {
			expect(maintenanceWireRequests[1]?.previous_response_id).toBe("resp_1");
		} else {
			const normalHttp = JSON.stringify(maintenanceWireRequests[1]);
			expect(normalHttp).toContain("wire answer 1");
			expect(normalHttp).toContain("PRUNE_NORMAL_BEFORE_REWRITE");
			expect(httpHeaders[1]?.get("x-codex-turn-state")).toBe("turn-1");
			expect(httpHeaders[1]?.get("x-models-etag")).toBe("etag-1");
		}

		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("pruned");
		const postPruneResult = await send();
		const postPruneRequest = maintenanceWireRequests[2];
		expect(postPruneRequest?.previous_response_id).toBeUndefined();
		const postPruneSerialized = JSON.stringify(postPruneRequest);
		for (const stale of [oldToolOutputs[0], "resp_1", "msg_1", "turn-1", "etag-1"]) {
			expect(postPruneSerialized).not.toContain(stale);
		}
		for (const retained of oldToolOutputs.slice(1)) {
			expect(postPruneSerialized.split(retained).length - 1).toBe(1);
		}
		for (const retained of ["KEPT_PRUNE_CALL", "KEPT_PRUNE_RESULT", "PRUNE_STEERING_ONE", "PRUNE_STEERING_TWO"]) {
			expect(postPruneSerialized.split(retained).length - 1).toBe(1);
		}
		if (transport === "websocket") {
			expect(maintenanceSockets).toHaveLength(2);
			expect(maintenanceSockets[1]?.options?.headers?.["x-codex-turn-state"]).toBeUndefined();
			expect(maintenanceSockets[1]?.options?.headers?.["x-models-etag"]).toBeUndefined();
		} else {
			expect(httpHeaders[2]?.get("x-codex-turn-state")).toBeNull();
			expect(httpHeaders[2]?.get("x-models-etag")).toBeNull();
		}

		await seed(session, [
			postPruneResult,
			{ role: "user", content: "PRUNE_NORMAL_AFTER_REWRITE", timestamp: Date.now() + 8 },
		]);
		await send();
		const resumedSerialized = JSON.stringify(maintenanceWireRequests[3]);
		if (transport === "websocket") {
			expect(maintenanceWireRequests[3]?.previous_response_id).toBe("resp_3");
			expect(maintenanceSockets).toHaveLength(2);
		} else {
			expect(resumedSerialized).toContain("wire answer 3");
			expect(resumedSerialized).toContain("PRUNE_NORMAL_AFTER_REWRITE");
			expect(httpHeaders[3]?.get("x-codex-turn-state")).toBe("turn-3");
			expect(httpHeaders[3]?.get("x-models-etag")).toBe("etag-3");
		}
	});

	it("closes a pending real Codex prewarm at the production rewrite fence and ignores late callbacks", async () => {
		session = await buildSession({
			shortCircuit: true,
			settings: {
				"compaction.keepRecentTokens": 10,
				"provider.appendOnlyContext": "on",
				"providers.openaiWebsockets": "on",
			},
		});
		const model = {
			...session.model!,
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: true,
		} as Model<"openai-codex-responses">;
		session.agent.setModel(model);
		session.agent.setAppendOnlyContext(createAppendOnlyContextManager("openai-codex"));
		global.WebSocket = MaintenanceCodexWebSocket as unknown as typeof WebSocket;
		global.fetch = vi.fn(async () => {
			throw new Error("unexpected SSE fallback");
		}) as unknown as typeof fetch;
		maintenanceHoldSocketOpen = true;
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const providerMap = session.providerSessionState;
		await seedCompactableConversation(session, THRESHOLD * 3);
		let prewarmSettled = false;
		const prewarm = prewarmOpenAICodexResponses(model, {
			apiKey: `aaa.${tokenPayload}.bbb`,
			sessionId: "maintenance-pending-prewarm",
			preferWebsockets: true,
			providerSessionState: providerMap,
		}).then(
			() => {
				prewarmSettled = true;
			},
			() => {
				prewarmSettled = true;
			},
		);
		await waitFor(() => maintenanceSockets.length === 1 && providerMap.has("openai-codex-responses"));
		const pendingSocket = maintenanceSockets[0];
		const prewarmState = providerMap.get("openai-codex-responses");
		expect(pendingSocket?.readyState).toBe(MaintenanceCodexWebSocket.CONNECTING);
		expect(prewarmState).toBeDefined();

		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("compacted");
		expect(providerMap.has("openai-codex-responses")).toBe(false);
		expect(session.providerSessionState).toBe(providerMap);
		expect(pendingSocket?.readyState).toBe(MaintenanceCodexWebSocket.CLOSED);

		pendingSocket?.open();
		pendingSocket?.complete(777);
		pendingSocket?.onerror?.(new Event("error"));
		pendingSocket?.close();
		await prewarm;
		await Promise.resolve();
		expect(prewarmSettled).toBe(true);
		expect(providerMap.has("openai-codex-responses")).toBe(false);
		expect(session.providerSessionState).toBe(providerMap);
		expect(maintenanceSockets).toHaveLength(1);
	});

	it("selects a larger-context promotion target instead of compacting", async () => {
		const sessionManager = SessionManager.inMemory();
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !largeModel) throw new Error("Expected codex spark + large models");
		const startModel = { ...sparkModel, contextWindow: 150_000 };
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: startModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": THRESHOLD,
				"contextPromotion.enabled": true,
			}),
			modelRegistry,
		});
		let closed = 0;
		const previousProviderSessionState = session.providerSessionState;
		previousProviderSessionState.set("openai-codex-responses", {
			close: () => closed++,
		} satisfies ProviderSessionState);
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(startModel, usage(THRESHOLD * 1.2)),
			assistant(startModel, usage(THRESHOLD * 1.2)),
		]);

		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
		expect(outcome).toBe("promoted");
		expect(session.model?.contextWindow).toBeGreaterThan(startModel.contextWindow!);
		expect(session.providerSessionState).not.toBe(previousProviderSessionState);
		expect(closed).toBe(0);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
	});

	it("rolls back a temporary promotion scope when cancellation lands after the model switch", async () => {
		const sessionManager = SessionManager.inMemory();
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !largeModel) throw new Error("Expected codex spark + large models");
		const startModel = { ...sparkModel, contextWindow: 150_000 };
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: startModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": THRESHOLD,
				"contextPromotion.enabled": true,
			}),
			modelRegistry,
		});
		const previousProviderSessionState = session.providerSessionState;
		previousProviderSessionState.set("openai-codex-responses", { close: () => {} });
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(startModel, usage(THRESHOLD * 1.2)),
		]);
		const cancellation = new AbortController();
		const originalSetModelTemporary = session.setModelTemporary.bind(session);
		session.setModelTemporary = async (...args) => {
			const scope = await originalSetModelTemporary(...args);
			cancellation.abort();
			return scope;
		};

		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session), {
			signal: cancellation.signal,
			awaitEventDrain: async () => {},
		});

		expect(outcome).toBe("aborted");
		expect(session.model?.id).toBe(startModel.id);
		expect(session.providerSessionState).toBe(previousProviderSessionState);
	});

	it("returns failed without issuing a completed Codex rewrite epoch", async () => {
		// No short-circuit extension and the runtime model registry exposes no
		// usable compaction candidate, so #runAutoCompaction skips without a new
		// compaction entry — reported as an explicit failure so the run still resumes.
		session = await buildSession({ shortCircuit: false });
		let closed = 0;
		const providerState = { close: () => closed++ } satisfies ProviderSessionState;
		session.providerSessionState.set("openai-codex-responses", providerState);
		const model = session.model!;
		await seed(session, [
			{ role: "user", content: "hi", timestamp: Date.now() } as never,
			assistant(model, usage(THRESHOLD * 3)),
			assistant(model, usage(THRESHOLD * 3)),
		]);
		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
		expect(outcome).toBe("failed");
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
		expect(closed).toBe(0);
		expect(session.providerSessionState.get("openai-codex-responses")).toBe(providerState);
	});

	it("aborts after event drain and flush complete but before history rewrite", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(session, THRESHOLD * 3);
		const cancellation = new AbortController();
		let providerCloseCount = 0;
		let drainCount = 0;
		let flushCount = 0;
		const providerState = { close: () => providerCloseCount++ } satisfies ProviderSessionState;
		session.providerSessionState.set("openai-codex-responses", providerState);
		const manager = session.sessionManager as unknown as { flush: () => Promise<void> };
		const originalFlush = manager.flush.bind(manager);
		manager.flush = async () => {
			await originalFlush();
			flushCount++;
			cancellation.abort();
		};

		const outcome = await session.runMidRunMaintenanceForTests(contextOf(session), {
			signal: cancellation.signal,
			awaitEventDrain: async () => {
				drainCount++;
			},
		});

		expect(outcome).toBe("aborted");
		expect(drainCount).toBe(1);
		expect(flushCount).toBe(1);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
		expect(providerCloseCount).toBe(0);
		expect(session.providerSessionState.get("openai-codex-responses")).toBe(providerState);
	});

	it("aborts while the compaction hook is in progress without completing a rewrite epoch", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(session, THRESHOLD * 3);
		const cancellation = new AbortController();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let providerCloseCount = 0;
		const providerState = { close: () => providerCloseCount++ } satisfies ProviderSessionState;
		session.providerSessionState.set("openai-codex-responses", providerState);
		(globalThis as { __midrunCompactEntered?: () => void }).__midrunCompactEntered = () => entered.resolve();
		(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = gate.promise;

		try {
			const maintenance = session.runMidRunMaintenanceForTests(contextOf(session), {
				signal: cancellation.signal,
				awaitEventDrain: async () => {},
			});
			await entered.promise;
			cancellation.abort();
			expect(await maintenance).toBe("aborted");
			expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
			expect(providerCloseCount).toBe(0);
			expect(session.providerSessionState.get("openai-codex-responses")).toBe(providerState);
		} finally {
			gate.resolve();
			(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = undefined;
			(globalThis as { __midrunCompactEntered?: () => void }).__midrunCompactEntered = undefined;
		}
	});

	it("does not double-compact while a compaction is already in flight", async () => {
		session = await buildSession({ shortCircuit: true, settings: { "compaction.keepRecentTokens": 10 } });
		await seedCompactableConversation(session, THRESHOLD * 3);
		// Block a long-lived idle compaction at session_before_compact so
		// isCompacting stays true, then confirm the mid-run checkpoint yields the
		// context instead of stacking a second (double) compaction underneath it.
		const gate = Promise.withResolvers<void>();
		(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = gate.promise;
		try {
			const inFlight = session.runIdleCompaction();
			const deadline = Date.now() + 1_000;
			while (!session.isCompacting && Date.now() < deadline) await Bun.sleep(5);
			expect(session.isCompacting).toBe(true);

			const outcome = await session.runMidRunMaintenanceForTests(contextOf(session));
			expect(outcome).toBe("not-needed");

			gate.resolve();
			await inFlight;
		} finally {
			(globalThis as { __midrunCompactGate?: Promise<void> }).__midrunCompactGate = undefined;
		}
	});
	it("T2 canonically persists paired tool results and distinct steering before a prune rewrite", async () => {
		session = await buildSession({ shortCircuit: true });
		let closed = 0;
		session.providerSessionState.set("openai-codex-responses", {
			close: () => closed++,
		} satisfies ProviderSessionState);
		const m = session.model!;
		const pairedToolResult = {
			role: "toolResult",
			toolCallId: "paired-result",
			toolName: "noop",
			content: [{ type: "text", text: "paired output" }],
			timestamp: Date.now(),
		};
		await seed(session, [
			{ role: "user", content: "earlier request", timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "old-output-1",
				toolName: "bash",
				content: [{ type: "text", text: "x".repeat(120_000) }],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "old-output-3",
				toolName: "bash",
				content: [{ type: "text", text: "z".repeat(120_000) }],
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "old-output-2",
				toolName: "bash",
				content: [{ type: "text", text: "y".repeat(120_000) }],
				timestamp: Date.now(),
			},
			assistant(m, usage(THRESHOLD + 1)),
			pairedToolResult,
			{ role: "user", content: "first distinct steering", timestamp: Date.now() },
			{ role: "user", content: "second distinct steering", timestamp: Date.now() },
		]);

		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("pruned");
		const persisted = session.sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "message"
					? [entry.message as { role?: string; toolCallId?: string; content?: unknown }]
					: [],
			);
		expect(persisted.filter(message => message.toolCallId === "paired-result")).toHaveLength(1);
		expect(
			persisted.filter(message => message.role === "user" && message.content === "first distinct steering"),
		).toHaveLength(1);
		expect(
			persisted.filter(message => message.role === "user" && message.content === "second distinct steering"),
		).toHaveLength(1);
		expect(closed).toBe(1);
		expect(getLatestCompactionEntry(session.sessionManager.getBranch())).toBeNull();
	});

	it("cleans a held EventStream consumer barrier before it can flush or rewrite", async () => {
		for (const operation of ["abort", "dispose", "disconnect"] as const) {
			const s = await buildSession({ shortCircuit: true });
			session = s;
			let providerCloseCount = 0;
			const providerState = { close: () => providerCloseCount++ } satisfies ProviderSessionState;
			s.providerSessionState.set("openai-codex-responses", providerState);
			const stream = new AssistantMessageEventStream();
			const consumerReady = Promise.withResolvers<void>();
			const heldConsumer = Promise.withResolvers<void>();
			const consumer = (async () => {
				for await (const _event of stream) {
					consumerReady.resolve();
					await heldConsumer.promise;
				}
			})();

			try {
				await seed(s, [
					{ role: "user", content: "barrier request", timestamp: Date.now() },
					assistant(s.model!, usage(THRESHOLD * 3)),
				]);
				stream.push({ type: "start", partial: assistant(s.model!, usage(1)) });
				await consumerReady.promise;
				let flushCount = 0;
				const manager = s.sessionManager as unknown as { flush: () => Promise<void> };
				const originalFlush = manager.flush.bind(manager);
				manager.flush = async () => {
					flushCount++;
					return originalFlush();
				};
				const maintenance = s.runMidRunMaintenanceForTests(contextOf(s), {
					signal: new AbortController().signal,
					awaitEventDrain: signal => stream.waitForConsumerDrain(signal),
				});
				await waitFor(
					() => s.activeMidRunBarrierCountForTests === 1 && stream.pendingConsumerDrainCountForTests === 1,
				);
				expect(flushCount).toBe(0);

				if (operation === "abort") await s.abort();
				else if (operation === "dispose") await s.dispose();
				else await s.newSession();

				expect(s.activeMidRunBarrierCountForTests).toBe(0);
				expect(stream.pendingConsumerDrainCountForTests).toBe(0);
				if (operation === "abort") expect(flushCount).toBe(0);

				expect(await maintenance).toBe("aborted");
				expect(getLatestCompactionEntry(s.sessionManager.getBranch())).toBeNull();
				if (operation === "abort") {
					expect(providerCloseCount).toBe(0);
					expect(s.providerSessionState.get("openai-codex-responses")).toBe(providerState);
					expect(flushCount).toBe(0);
				}
			} finally {
				heldConsumer.resolve();
				stream.end();
				await consumer;
				await s.dispose();
			}
		}
	});

	it("T6 attempts identical provider-response anchors at most once", async () => {
		session = await buildSession({ shortCircuit: false });
		await seed(session, [
			{ role: "user", content: "anti-wedge request", timestamp: Date.now() },
			assistant(session.model!, usage(THRESHOLD * 3)),
		]);
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("failed");
		expect(await session.runMidRunMaintenanceForTests(contextOf(session))).toBe("not-needed");
	});
});
