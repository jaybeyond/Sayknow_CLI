import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model, streamSimple } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { ExtensionToolWrapper } from "@sayknow-cli/coding-agent/extensibility/extensions/wrapper";
import { createAgentSession } from "@sayknow-cli/coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import {
	AUTO_RESUME_MARKER_CUSTOM_TYPE,
	findInterruptedToolCalls,
	isRestartSafeTool,
	resolveAutoResumePolicy,
} from "@sayknow-cli/coding-agent/session/auto-resume";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import { ReadTool } from "@sayknow-cli/coding-agent/tools/read";
import { TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";

/**
 * Automatic same-model resume. Every case runs the production AgentSession and the
 * real openai-completions serializer; only `globalThis.fetch` is replaced, so each
 * fetch call is one concrete upstream request and its body is the actual wire.
 */

type Reply = () => Response;

interface WireLog {
	bodies: string[];
}

function installReplies(replies: readonly Reply[]): WireLog {
	const log: WireLog = { bodies: [] };
	vi.spyOn(globalThis, "fetch").mockImplementation((async (
		_input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		log.bodies.push(typeof init?.body === "string" ? init.body : "");
		const reply = replies[log.bodies.length - 1];
		if (!reply) throw new Error(`Unexpected outbound request #${log.bodies.length}`);
		return reply();
	}) as typeof fetch);
	return log;
}

function status503(): Response {
	return new Response(
		JSON.stringify({ error: { message: "Service temporarily unavailable", type: "server_error", code: null } }),
		{ status: 503, headers: { "content-type": "application/json", "retry-after-ms": "1" } },
	);
}

function sse(frames: readonly string[]): Reply {
	return () => {
		const encoder = new TextEncoder();
		let next = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (next < frames.length) controller.enqueue(encoder.encode(frames[next++]));
					else controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

function oc(model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-resume",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}
const OC_DONE = "data: [DONE]\n\n";

function textReply(model: string, text: string): Reply {
	return sse([oc(model, { role: "assistant" }), oc(model, { content: text }), oc(model, {}, "stop"), OC_DONE]);
}

function toolCallReply(model: string, id: string, name: string): Reply {
	return sse([
		oc(model, { role: "assistant" }),
		oc(model, { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "{}" } }] }),
		oc(model, {}, "tool_calls"),
		OC_DONE,
	]);
}

function toolNames(body: string): string[] {
	const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
	return (parsed.tools ?? []).map(tool => tool.function?.name ?? "").sort();
}

function toolSession(cwd: string): ToolSession {
	return { cwd, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings: Settings.isolated() };
}

describe("automatic same-model resume", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@auto-resume-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
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

	function groq(): Model {
		const found = getBundledModel("groq", "llama-3.3-70b-versatile");
		if (!found) throw new Error("missing bundled model");
		return found;
	}

	function build(options: {
		model: Model;
		tools?: AgentTool[];
		sessionManager?: SessionManager;
		settings?: Parameters<typeof Settings.isolated>[0];
		streamFn?: typeof streamSimple;
	}): AgentSession {
		const m = options.model;
		authStorage.setRuntimeApiKey(m.provider, `${m.provider}-test-key`);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: m, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: options.streamFn ?? streamSimple,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.auto": false,
			"retry.maxRetries": 3,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			...options.settings,
		});
		settings.setModelRole("default", `${m.provider}/${m.id}`);
		const built = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		built.subscribe(() => {});
		return built;
	}

	function counted(name: string): { tool: AgentTool; runs: () => number } {
		let runs = 0;
		return {
			runs: () => runs,
			tool: {
				name,
				label: name,
				description: `Counts real ${name} executions`,
				parameters: z.object({ path: z.string().optional() }),
				execute: async () => {
					runs++;
					return { content: [{ type: "text" as const, text: `${name} result` }] };
				},
			},
		};
	}

	function readTool(): AgentTool {
		return new ReadTool(toolSession(tempDir.path())) as AgentTool;
	}

	function events(s: AgentSession): AgentSessionEvent[] {
		const seen: AgentSessionEvent[] = [];
		s.subscribe(event => {
			seen.push(event);
		});
		return seen;
	}

	function markerCount(s: AgentSession): number {
		return s.sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === AUTO_RESUME_MARKER_CUSTOM_TYPE).length;
	}

	async function interruptedSession(options: {
		messages: AgentMessage[];
		checkpoint: Record<string, unknown>;
	}): Promise<SessionManager> {
		const dir = tempDir.path();
		const first = SessionManager.create(dir, dir);
		for (const message of options.messages) first.appendMessage(message as Parameters<typeof first.appendMessage>[0]);
		first.appendCustomEntry("recovery_checkpoint", { version: 1, state: "in_flight", ...options.checkpoint });
		await first.ensureOnDisk();
		await first.flush();
		const file = first.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		return SessionManager.open(file);
	}

	function assistantWithCall(m: Model, id: string, name: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: {} }],
			api: m.api,
			provider: m.provider,
			model: m.id,
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	const selectorOf = (m: Model) => `${m.provider}/${m.id}`;
	const restartCheckpoint = (m: Model) => ({
		stepId: "lost-step",
		selector: selectorOf(m),
		api: m.api,
		uncertain: [],
	});

	// ------------------------------------------------------------ restart (P-A)
	it("1) restart resumes an interrupted write once, read-only, without re-running it", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession({
			messages: [
				{ role: "user", content: "update the file", timestamp: Date.now() },
				assistantWithCall(m, "w1", "write"),
			],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([textReply(m.id, "verified, the write needs checking")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		const seen = events(session);

		await session.continuePersistedHistory();
		await session.waitForIdle();

		expect(log.bodies).toHaveLength(1);
		expect(write.runs()).toBe(0);
		// Restricted mode exposes only the built-in read tool on the wire.
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		expect(log.bodies[0]).toContain("Interrupted before its outcome was observed");
		expect(log.bodies[0]).toContain("Only read-only tools are available now");
		// The selection itself is untouched and restored after the run.
		expect(session.getActiveToolNames().sort()).toEqual(["read", "write"]);
		expect(markerCount(session)).toBe(1);
		expect(
			seen.some(event => event.type === "notice" && event.message.includes("automatically (read-only tools)")),
		).toBe(true);
	});

	it("6) a second restart after an automatic resume sends nothing", async () => {
		const m = groq();
		const dir = tempDir.path();
		const first = SessionManager.create(dir, dir);
		first.appendMessage({ role: "user", content: "update", timestamp: Date.now() });
		first.appendMessage(assistantWithCall(m, "w1", "write"));
		first.appendCustomEntry("recovery_checkpoint", { version: 1, state: "in_flight", ...restartCheckpoint(m) });
		first.appendCustomEntry(AUTO_RESUME_MARKER_CUSTOM_TYPE, { version: 1, trigger: "restart" });
		await first.ensureOnDisk();
		await first.flush();
		const reopened = await SessionManager.open(first.getSessionFile() ?? "");
		const log = installReplies([]);
		session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);

		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
	});

	it("9) a marker that cannot be made durable sends nothing", async () => {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([]);
		session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		vi.spyOn(session.sessionManager, "flush").mockRejectedValue(new Error("disk failure"));

		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
	});

	it("18) a restart never resumes a step with persisted uncertainty or an opaque/legacy checkpoint", async () => {
		const m = groq();
		for (const checkpoint of [
			{ ...restartCheckpoint(m), uncertain: ["broker forced refresh"] },
			{ ...restartCheckpoint(m), api: "cursor-agent" },
			{ ...restartCheckpoint(m), transport: "pi-native" },
			{ stepId: "legacy-step" },
		]) {
			const reopened = await interruptedSession({
				messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
				checkpoint,
			});
			const log = installReplies([]);
			session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
			session.agent.replaceMessages(reopened.buildSessionContext().messages);
			await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
			expect(log.bodies).toHaveLength(0);
			await session.dispose();
			session = undefined;
			vi.restoreAllMocks();
		}
	});

	it("15) a restart on a different model than the interrupted step pauses", async () => {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: { ...restartCheckpoint(m), selector: "openai/gpt-4o-mini" },
		});
		const log = installReplies([]);
		session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
	});

	it("5) a restart resume spends at most two requests", async () => {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([status503, status503, status503, status503]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);

		await session.continuePersistedHistory().catch(() => undefined);
		await session.waitForIdle();
		expect(log.bodies.length).toBeLessThanOrEqual(2);
		expect(markerCount(session)).toBe(1);
	});

	it("12) a name-alike read from an extension is not restart-safe", async () => {
		const m = groq();
		const fakeRead = counted("read");
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([]);
		session = build({ model: m, tools: [counted("write").tool, fakeRead.tool], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
	});

	it("16) retry.autoResume=false keeps the restart pause", async () => {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([]);
		session = build({
			model: m,
			tools: [counted("write").tool, readTool()],
			sessionManager: reopened,
			settings: { "retry.autoResume": false },
		});
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
	});

	// ------------------------------------------------------------ in-process (P-B)
	it("2) a transient failure after executed tools resumes once with every tool and replays nothing", async () => {
		const m = groq();
		const write = counted("write");
		const log = installReplies([
			toolCallReply(m.id, "w1", "write"),
			status503,
			status503,
			status503,
			status503,
			textReply(m.id, "done after resume"),
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()] });

		await session.prompt("write then answer");
		for (let i = 0; i < 50 && session.agent.state.messages.at(-1)?.role !== "assistant"; i++) await Bun.sleep(5);
		await session.waitForIdle();
		for (let i = 0; i < 50 && log.bodies.length < 6; i++) await Bun.sleep(5);
		await session.waitForIdle();

		// One tool loop, three retries inside the step, then exactly one automatic resume.
		expect(log.bodies).toHaveLength(6);
		expect(log.bodies.length).toBeLessThanOrEqual(1 + 7);
		expect(write.runs()).toBe(1);
		expect(toolNames(log.bodies[5])).toEqual(["read", "write"]);
		expect(markerCount(session)).toBe(1);
		const last = session.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	it("14) an abort right after the resume is scheduled sends nothing and restores the tool view", async () => {
		const m = groq();
		const write = counted("write");
		const log = installReplies([toolCallReply(m.id, "w1", "write"), status503, status503, status503, status503]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()] });
		const live = session;
		live.subscribe(event => {
			if (event.type === "notice" && event.message.startsWith("Resuming the interrupted step")) live.abort();
		});

		await live.prompt("write then answer");
		await live.waitForIdle();
		await Bun.sleep(20);
		await live.waitForIdle();

		expect(log.bodies).toHaveLength(5);
		expect(write.runs()).toBe(1);
		expect(markerCount(live)).toBe(1);
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);
	});

	it("stale resume instructions are dropped from later turns", () => {
		const llm = convertToLlm([
			{ role: "user", content: "first", timestamp: 0 },
			{
				role: "custom",
				customType: "auto-resume",
				content: "resume instruction",
				display: false,
				attribution: "agent",
				timestamp: 1,
			},
			{ role: "user", content: "second", timestamp: 2 },
		]);
		expect(JSON.stringify(llm)).not.toContain("resume instruction");
	});

	function managedRun(replies: readonly Reply[]): { urls: string[]; bodies: string[] } {
		const urls: string[] = [];
		const bodies: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			urls.push(input instanceof Request ? input.url : String(input));
			bodies.push(typeof init?.body === "string" ? init.body : "");
			const reply = replies[bodies.length - 1];
			return reply ? reply() : status503();
		}) as typeof fetch);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		return { urls, bodies };
	}

	it("4) a managed chain resumes once on the interrupted model without advancing the chain", async () => {
		const m = groq();
		const write = counted("write");
		const { urls, bodies } = managedRun([
			toolCallReply(m.id, "w1", "write"),
			status503,
			status503,
			status503,
			status503,
			textReply(m.id, "done after resume"),
		]);
		session = build({ model: m, tools: [write.tool, readTool()] });
		session.settings.setModelRole("default", [`${m.provider}/${m.id}`, "openai/gpt-4o-mini"]);
		const continueSpy = vi.spyOn(session.agent, "continue");

		await session.prompt("write then answer");
		await session.waitForIdle();
		await Bun.sleep(20);
		await session.waitForIdle();

		expect(write.runs()).toBe(1);
		// The resume runs outside the managed chain: no fallback can switch the model.
		expect(continueSpy.mock.calls.at(-1)?.[0]?.fallbackManaged).toBeUndefined();
		expect(bodies).toHaveLength(6);
		expect(bodies[5]).toContain("interrupted before it finished");
		expect(urls.every(url => url.includes("api.groq.com"))).toBe(true);
		expect(markerCount(session)).toBe(1);
	});
	it("4b) a transient failure inside the resumed run retries on the same model only", async () => {
		const m = groq();
		const write = counted("write");
		const { urls, bodies } = managedRun([
			toolCallReply(m.id, "w1", "write"),
			status503,
			status503,
			status503,
			status503,
			status503,
			textReply(m.id, "done after resume"),
		]);
		session = build({ model: m, tools: [write.tool, readTool()] });
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		session.settings.setModelRole("default", [`${m.provider}/${m.id}`, "openai/gpt-4o-mini"]);

		await session.prompt("write then answer");
		await session.waitForIdle();
		for (let i = 0; i < 50 && bodies.length < 7; i++) await Bun.sleep(5);
		await session.waitForIdle();

		expect(write.runs()).toBe(1);
		expect(markerCount(session)).toBe(1);
		expect(bodies).toHaveLength(7);
		expect(urls.every(url => url.includes("api.groq.com"))).toBe(true);
		const last = session.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	it("4c) a quota failure inside the resumed run stops on the interrupted model", async () => {
		const m = groq();
		const write = counted("write");
		const quota: Reply = () =>
			new Response(
				JSON.stringify({
					error: {
						message: "You exceeded your current quota",
						type: "insufficient_quota",
						code: "insufficient_quota",
					},
				}),
				{ status: 429, headers: { "content-type": "application/json" } },
			);
		const { urls, bodies } = managedRun([
			toolCallReply(m.id, "w1", "write"),
			status503,
			status503,
			status503,
			status503,
			quota,
			textReply("gpt-4o-mini", "switched model"),
		]);
		session = build({ model: m, tools: [write.tool, readTool()] });
		// The next chain entry is usable, so only the pin keeps the resume on groq.
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		session.settings.setModelRole("default", [`${m.provider}/${m.id}`, "openai/gpt-4o-mini"]);
		const seen = events(session);

		await session.prompt("write then answer");
		await session.waitForIdle();
		await Bun.sleep(20);
		await session.waitForIdle();

		expect(write.runs()).toBe(1);
		expect(markerCount(session)).toBe(1);
		// The resume's quota failure is the last request: no other model is contacted.
		expect(bodies).toHaveLength(6);
		expect(urls.every(url => url.includes("api.groq.com"))).toBe(true);
		expect(seen.some(event => event.type === "model_fallback_switched")).toBe(false);
		expect(session.model?.id).toBe(m.id);
	});

	it("5b) a step whose budget is spent never resumes (no second budget)", async () => {
		const m = groq();
		const write = counted("write");
		const { bodies } = managedRun([toolCallReply(m.id, "w1", "write")]);
		session = build({ model: m, tools: [write.tool, readTool()], settings: { "retry.maxRetries": 99 } });
		session.settings.setModelRole("default", [`${m.provider}/${m.id}`, "openai/gpt-4o-mini"]);

		await session.prompt("write then answer");
		await session.waitForIdle();
		await Bun.sleep(20);
		await session.waitForIdle();

		// One tool step plus at most seven requests for the failing step.
		expect(bodies.length).toBeLessThanOrEqual(1 + 7);
		expect(markerCount(session)).toBe(0);
	});

	// ------------------------------------------------------------ pure policy
	it("policy pauses on every guard and resumes restricted only with interrupted calls", () => {
		const m = groq();
		const read = readTool();
		const write = counted("write").tool;
		const base = {
			enabled: true,
			trigger: "restart" as const,
			messages: [
				{ role: "user" as const, content: "x", timestamp: 0 },
				assistantWithCall(m, "w1", "write"),
			] as AgentMessage[],
			resumedThisTurn: false,
			uncertainUpstream: false,
			opaqueTransport: false,
			budgetAdmits: true,
			userInputPending: false,
			selectorAvailable: true,
			prefixReplayable: true,
			selectedTools: [read, write],
		};
		expect(resolveAutoResumePolicy(base)).toMatchObject({ type: "resume", mode: "restricted" });
		expect(resolveAutoResumePolicy({ ...base, enabled: false })).toEqual({ type: "pause", reason: "disabled" });
		expect(resolveAutoResumePolicy({ ...base, resumedThisTurn: true }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, uncertainUpstream: true }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, opaqueTransport: true }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, budgetAdmits: false }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, userInputPending: true }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, selectorAvailable: false }).type).toBe("pause");
		expect(resolveAutoResumePolicy({ ...base, selectedTools: [write] })).toEqual({
			type: "pause",
			reason: "no_restart_safe_tools",
		});
		// A completed call is never treated as interrupted (11).
		const completed = [
			...base.messages,
			{ role: "toolResult", toolCallId: "w1", toolName: "write", content: [], isError: false, timestamp: 1 },
		] as AgentMessage[];
		expect(findInterruptedToolCalls(completed)).toEqual([]);
		expect(resolveAutoResumePolicy({ ...base, messages: completed })).toMatchObject({ type: "resume", mode: "full" });
		// Signed reasoning or a cut-off call in a failed tail never resumes.
		const failedWithThinking: AssistantMessage = {
			...assistantWithCall(m, "w2", "write"),
			content: [{ type: "thinking", thinking: "secret", thinkingSignature: "sig" }],
			stopReason: "error",
		};
		expect(
			resolveAutoResumePolicy({ ...base, messages: [base.messages[0], failedWithThinking] as AgentMessage[] }),
		).toEqual({ type: "pause", reason: "unsafe_tail" });
		// A visible text prefix needs a faithful serializer projection.
		const failedText: AssistantMessage = {
			...assistantWithCall(m, "w3", "write"),
			content: [{ type: "text", text: "partial" }],
			stopReason: "error",
		};
		expect(
			resolveAutoResumePolicy({
				...base,
				prefixReplayable: false,
				messages: [base.messages[0], failedText] as AgentMessage[],
			}),
		).toEqual({ type: "pause", reason: "unsafe_tail" });
	});

	it("restart-safe tools are built-in read-only instances with a unique wire name", () => {
		const read = readTool();
		const write = counted("write").tool;
		expect(isRestartSafeTool(read, [read, write])).toBe(true);
		expect(isRestartSafeTool(write, [read, write])).toBe(false);
		const alike = counted("read").tool;
		expect(isRestartSafeTool(alike, [alike])).toBe(false);
		expect(isRestartSafeTool(read, [read, alike])).toBe(false);
		const shadow = { ...counted("other").tool, customWireName: "read" } as AgentTool;
		expect(isRestartSafeTool(read, [read, shadow])).toBe(false);
	});

	it("restart-safe identification sees through extension and hook interception wrappers", () => {
		const read = readTool();
		const runner = { hasHandlers: () => false } as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
		const wrapped = new ExtensionToolWrapper(read, runner) as AgentTool;
		expect(wrapped instanceof ReadTool).toBe(false);
		expect(isRestartSafeTool(wrapped, [wrapped])).toBe(true);
		const alike = new ExtensionToolWrapper(counted("read").tool, runner) as AgentTool;
		expect(isRestartSafeTool(alike, [alike])).toBe(false);
	});

	async function sdkRestart(settings: Record<string, unknown>) {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [
				{ role: "user", content: "update the file", timestamp: Date.now() },
				assistantWithCall(m, "w1", "write"),
			],
			checkpoint: restartCheckpoint(m),
		});
		authStorage.setRuntimeApiKey(m.provider, `${m.provider}-test-key`);
		const { session: sdkSession } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager: reopened,
			settings: Settings.isolated({ "compaction.enabled": false, "fallback.auto": false, ...settings }),
			model: m,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "write"],
		});
		session = sdkSession;
		return { m, sdkSession };
	}

	for (const appendOnly of ["off", "on"] as const) {
		it(`1b/19) a production SDK session resumes an interrupted write read-only after a restart (append-only ${appendOnly})`, async () => {
			const log = installReplies([textReply(groq().id, "verified")]);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { sdkSession } = await sdkRestart({ "provider.appendOnlyContext": appendOnly });
			expect(sdkSession.agent.appendOnlyContext !== undefined).toBe(appendOnly === "on");
			expect(sdkSession.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write"]));

			await sdkSession.continuePersistedHistory();
			await sdkSession.waitForIdle();

			expect(log.bodies).toHaveLength(1);
			// The production tool set is wrapped for extensions; only the built-in read reaches the wire.
			expect(toolNames(log.bodies[0])).toEqual(["read"]);
			expect(log.bodies[0]).toContain("Interrupted before its outcome was observed");
			expect(log.bodies[0]).not.toContain("synthesized on resume");
			expect(markerCount(sdkSession)).toBe(1);
		});
	}

	it("17) the active tool list stays the user's during a restricted resume, and later changes are kept", async () => {
		const m = groq();
		const write = counted("write");
		const extra = counted("notes");
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([
			toolCallReply(m.id, "r1", "read"),
			textReply(m.id, "checked"),
			textReply(m.id, "next"),
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		const live = session;
		let changed = false;
		live.subscribe(event => {
			if (event.type === "tool_execution_start" && !changed) {
				changed = true;
				// A tool refresh mid-resume (as MCP refresh does) changes the selection itself.
				live.agent.setTools([...live.agent.state.tools, extra.tool]);
				expect(live.getActiveToolNames().sort()).toEqual(["notes", "read", "write"]);
			}
		});

		await live.continuePersistedHistory();
		await live.waitForIdle();
		expect(toolNames(log.bodies[1])).toEqual(["read"]);

		await live.prompt("next");
		await live.waitForIdle();
		expect(toolNames(log.bodies[2])).toEqual(["notes", "read", "write"]);
	});

	it("10) a restart resume stops at its own deadline instead of waiting", async () => {
		const m = groq();
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		let now = 1_000;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const log = installReplies([
			() => {
				// The first attempt fails after the 120 s restart window has passed.
				now += 121_000;
				return status503();
			},
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [counted("write").tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);

		await session.continuePersistedHistory();
		await session.waitForIdle();
		await Bun.sleep(20);
		await session.waitForIdle();

		expect(log.bodies).toHaveLength(1);
		expect(markerCount(session)).toBe(1);
	});

	it("a restart never resumes an answer that already finished", async () => {
		const m = groq();
		const finished: AssistantMessage = {
			...assistantWithCall(m, "unused", "write"),
			content: [{ type: "text", text: "all done" }],
			stopReason: "stop",
		};
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "summarize", timestamp: Date.now() }, finished],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([]);
		session = build({ model: m, tools: [readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);

		await expect(session.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		expect(log.bodies).toHaveLength(0);
		expect(markerCount(session)).toBe(0);
	});

	it("a queued follow-up keeps the resumed run read-only until the user message reaches the model", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession({
			messages: [{ role: "user", content: "update", timestamp: Date.now() }, assistantWithCall(m, "w1", "write")],
			checkpoint: restartCheckpoint(m),
		});
		const log = installReplies([
			toolCallReply(m.id, "r1", "read"),
			textReply(m.id, "checked"),
			textReply(m.id, "follow-up answered"),
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()], sessionManager: reopened });
		session.agent.replaceMessages(reopened.buildSessionContext().messages);
		const live = session;
		let queued = false;
		live.subscribe(event => {
			if (event.type === "tool_execution_start" && !queued) {
				queued = true;
				void live.followUp("now write it");
			}
		});

		await live.continuePersistedHistory();
		await live.waitForIdle();
		for (let i = 0; i < 50 && log.bodies.length < 3; i++) await Bun.sleep(5);
		await live.waitForIdle();

		expect(log.bodies).toHaveLength(3);
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		// Queuing did not lift the restriction for the rest of the resumed run.
		expect(toolNames(log.bodies[1])).toEqual(["read"]);
		// Once the user's message is in the model context, the user directs the turn.
		expect(log.bodies[2]).toContain("now write it");
		expect(toolNames(log.bodies[2])).toEqual(["read", "write"]);
		expect(write.runs()).toBe(0);
	});

	it("a failure after a visible text prefix resumes once, inside the same step budget", async () => {
		const m = groq();
		const partialThenDrop: Reply = () => {
			const encoder = new TextEncoder();
			let sent = false;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						if (!sent) {
							sent = true;
							controller.enqueue(
								encoder.encode(oc(m.id, { role: "assistant" }) + oc(m.id, { content: "Three findings: one," })),
							);
							return;
						}
						controller.error(new Error("socket hang up"));
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const log = installReplies([partialThenDrop, partialThenDrop, textReply(m.id, " two, three.")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [readTool()], settings: { "retry.maxRetries": 1 } });
		const deltas: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("report");
		await session.waitForIdle();
		for (let i = 0; i < 50 && log.bodies.length < 3; i++) await Bun.sleep(5);
		await session.waitForIdle();

		expect(log.bodies).toHaveLength(3);
		expect(markerCount(session)).toBe(1);
		// The resume request carries the preserved prefix; nothing shown is re-emitted.
		expect(log.bodies[2]).toContain("Three findings: one,");
		expect(deltas.filter(delta => delta === " two, three.")).toHaveLength(1);
		const last = session.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	it("a failed uncertainty write closes only its own step and is reported", async () => {
		const m = groq();
		const log = installReplies([textReply(m.id, "fresh")]);
		let uncertainOnce = true;
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			tools: [readTool()],
			streamFn: (requested, context, options) => {
				if (uncertainOnce) {
					uncertainOnce = false;
					options?.onUncertainUpstream?.("Gateway dispatch has unobserved remote requests and effects");
				}
				return streamSimple(requested, context, options);
			},
		});
		const manager = session.sessionManager;
		const originalFlush = manager.flush.bind(manager);
		let failed = false;
		vi.spyOn(manager, "flush").mockImplementation(async () => {
			const checkpoint = manager
				.getBranch()
				.findLast(entry => entry.type === "custom" && entry.customType === "recovery_checkpoint");
			const uncertain =
				checkpoint?.type === "custom" ? (checkpoint.data as { uncertain?: unknown[] }).uncertain : [];
			if (!failed && Array.isArray(uncertain) && uncertain.length > 0) {
				failed = true;
				throw new Error("disk full");
			}
			await originalFlush();
		});
		const seen = events(session);

		await session.prompt("dispatch remotely");
		await session.waitForIdle();
		// The write failed before the request was admitted: nothing is sent for this step.
		expect(failed).toBe(true);
		expect(log.bodies).toHaveLength(0);
		expect(
			seen.some(event => event.type === "notice" && event.message.includes("could not be saved (disk full)")),
		).toBe(true);

		// The next user turn is a new step: admission is open again.
		await session.prompt("start over");
		await session.waitForIdle();
		expect(log.bodies).toHaveLength(1);
		const last = session.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});
});
