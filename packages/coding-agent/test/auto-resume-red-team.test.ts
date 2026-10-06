import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model, streamSimple } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { ExtensionToolWrapper } from "@sayknow-cli/coding-agent/extensibility/extensions/wrapper";
import { AgentSession, type AgentSessionEvent } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { AUTO_RESUME_MARKER_CUSTOM_TYPE } from "@sayknow-cli/coding-agent/session/auto-resume";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import { ReadTool } from "@sayknow-cli/coding-agent/tools/read";
import { TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";

/**
 * Red-team cases for automatic same-model resume (G003). Every session case runs the
 * production AgentSession with the real openai-completions serializer; only
 * `globalThis.fetch` is replaced, so each recorded body is one concrete upstream request.
 */

type Reply = () => Response;

interface WireLog {
	bodies: string[];
}

/** Replies in order; beyond the list every request gets a 503 (an unbounded supply of failures). */
function installReplies(replies: readonly Reply[], fallback?: Reply): WireLog {
	const log: WireLog = { bodies: [] };
	vi.spyOn(globalThis, "fetch").mockImplementation((async (
		_input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		log.bodies.push(typeof init?.body === "string" ? init.body : "");
		const reply = replies[log.bodies.length - 1] ?? fallback;
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
		id: "chatcmpl-redteam",
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

function toolCallReply(model: string, id: string, name: string, args: Record<string, unknown> = {}): Reply {
	return sse([
		oc(model, { role: "assistant" }),
		oc(model, {
			tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
		}),
		oc(model, {}, "tool_calls"),
		OC_DONE,
	]);
}

/** Streams a visible text prefix, then the socket drops. */
function prefixThenDrop(model: string, text: string): Reply {
	return () => {
		const encoder = new TextEncoder();
		let sent = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (!sent) {
						sent = true;
						controller.enqueue(encoder.encode(oc(model, { role: "assistant" }) + oc(model, { content: text })));
						return;
					}
					controller.error(new Error("socket hang up"));
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

function toolNames(body: string): string[] {
	const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
	return (parsed.tools ?? []).map(tool => tool.function?.name ?? "").sort();
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function toolSession(cwd: string): ToolSession {
	return { cwd, hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings: Settings.isolated() };
}

const RESUME_FULL_TEXT = "interrupted before it finished";
const RESUME_RESTRICTED_TEXT = "Only read-only tools are available now";

describe("automatic same-model resume — red team", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@auto-resume-redteam-");
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
		wireToolChoiceQueue?: boolean;
	}): AgentSession {
		const m = options.model;
		authStorage.setRuntimeApiKey(m.provider, `${m.provider}-test-key`);
		let owner: AgentSession | undefined;
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: m, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: options.streamFn ?? streamSimple,
			convertToLlm,
			// Production (sdk/session.ts) feeds the session's tool-choice queue into the agent.
			...(options.wireToolChoiceQueue ? { getToolChoice: () => owner?.nextToolChoice() } : {}),
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
		owner = built;
		built.subscribe(() => {});
		return built;
	}

	function counted(name: string, extra?: Partial<AgentTool>): { tool: AgentTool; runs: () => number } {
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
				...extra,
			} as AgentTool,
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

	function markerCount(s: AgentSession | SessionManager): number {
		const manager = s instanceof SessionManager ? s : s.sessionManager;
		return manager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === AUTO_RESUME_MARKER_CUSTOM_TYPE).length;
	}

	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function assistantWithCalls(m: Model, calls: Array<{ id: string; name: string }>): AssistantMessage {
		return {
			role: "assistant",
			content: calls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: {} })),
			api: m.api,
			provider: m.provider,
			model: m.id,
			stopReason: "toolUse",
			usage: zeroUsage,
			timestamp: Date.now(),
		};
	}

	function completedResult(id: string, name: string, text: string): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		} as AgentMessage;
	}

	const selectorOf = (m: Model) => `${m.provider}/${m.id}`;
	const restartCheckpoint = (m: Model) => ({
		stepId: "lost-step",
		selector: selectorOf(m),
		api: m.api,
		uncertain: [],
	});

	async function interruptedSession(messages: AgentMessage[], m: Model): Promise<SessionManager> {
		const dir = tempDir.path();
		const first = SessionManager.create(dir, dir);
		for (const message of messages) first.appendMessage(message as Parameters<typeof first.appendMessage>[0]);
		first.appendCustomEntry("recovery_checkpoint", { version: 1, state: "in_flight", ...restartCheckpoint(m) });
		await first.ensureOnDisk();
		await first.flush();
		const file = first.getSessionFile();
		if (!file) throw new Error("expected persisted session file");
		return SessionManager.open(file);
	}

	function restartWith(reopened: SessionManager, options: Omit<Parameters<typeof build>[0], "sessionManager">) {
		const built = build({ ...options, sessionManager: reopened });
		built.agent.replaceMessages(reopened.buildSessionContext().messages);
		session = built;
		return built;
	}

	async function settle(s: AgentSession, until: () => boolean = () => false): Promise<void> {
		await s.waitForIdle();
		for (let i = 0; i < 60 && !until(); i++) await Bun.sleep(5);
		await s.waitForIdle();
		await Bun.sleep(20);
		await s.waitForIdle();
	}

	// ------------------------------------------------------------------ RT1 (plan 11)
	it("RT1a) restart: a completed earlier write and an interrupted later write are both executed 0 times", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update two files", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w0", name: "write" }]),
				completedResult("w0", "write", "FIRST-WRITE-OK"),
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([textReply(m.id, "checked")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });

		await live.continuePersistedHistory();
		await settle(live);

		expect(log.bodies).toHaveLength(1);
		expect(write.runs()).toBe(0);
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		// The completed result is replayed as history exactly once; only w1 gets a placeholder.
		expect(occurrences(log.bodies[0], "FIRST-WRITE-OK")).toBe(1);
		expect(occurrences(log.bodies[0], "Interrupted before its outcome was observed")).toBe(1);
		expect(markerCount(live)).toBe(1);
	});

	it("RT1b) restart: mixed completed+interrupted calls in one assistant message are executed 0 times", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update two files", timestamp: Date.now() },
				assistantWithCalls(m, [
					{ id: "w0", name: "write" },
					{ id: "w1", name: "write" },
				]),
				completedResult("w0", "write", "FIRST-WRITE-OK"),
			],
			m,
		);
		const log = installReplies([textReply(m.id, "checked")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });

		await live.continuePersistedHistory();
		await settle(live);

		expect(log.bodies).toHaveLength(1);
		expect(write.runs()).toBe(0);
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		expect(occurrences(log.bodies[0], "FIRST-WRITE-OK")).toBe(1);
		expect(occurrences(log.bodies[0], "Interrupted before its outcome was observed")).toBe(1);
		const parsed = JSON.parse(log.bodies[0]) as { messages: Array<{ role: string; tool_call_id?: string }> };
		const toolIds = parsed.messages.filter(message => message.role === "tool").map(message => message.tool_call_id);
		expect(toolIds).toEqual(["w0", "w1"]);
	});

	// ------------------------------------------------------------------ RT2 (plan 13)
	it("RT2) restricted resume: a write call emitted by the model is never executed and gets an error result", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([toolCallReply(m.id, "w2", "write"), textReply(m.id, "could not write")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });

		await live.continuePersistedHistory();
		await settle(live, () => log.bodies.length >= 2);

		expect(write.runs()).toBe(0);
		expect(log.bodies).toHaveLength(2);
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		// The restriction holds for every request of the resumed run.
		expect(toolNames(log.bodies[1])).toEqual(["read"]);
		const result = live.agent.state.messages.find(
			message => message.role === "toolResult" && message.toolCallId === "w2",
		);
		expect(result?.role === "toolResult" && result.isError).toBe(true);
		// The selection itself is unchanged and the filter is lifted afterwards.
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);
	});

	// ------------------------------------------------------------------ RT3 (plan 20)
	it("RT3a) restricted resume: a user-forced tool choice naming write is downgraded on the wire", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([textReply(m.id, "checked")]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, {
			model: m,
			tools: [write.tool, readTool()],
			wireToolChoiceQueue: true,
		});
		live.setForcedToolChoice("write");

		await live.continuePersistedHistory();
		await settle(live);

		expect(log.bodies).toHaveLength(1);
		const body = JSON.parse(log.bodies[0]) as { tool_choice?: unknown };
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		expect(JSON.stringify(body.tool_choice ?? null)).not.toContain("write");
		expect(write.runs()).toBe(0);
	});

	it("RT3b) agent filter downgrades every named tool-choice shape that points at a withheld tool", async () => {
		const shapes = [
			{ type: "tool", name: "write" },
			{ type: "function", name: "write" },
			{ type: "function", function: { name: "write" } },
		] as const;
		for (const forced of shapes) {
			let writeRuns = 0;
			const tool = (name: string): AgentTool =>
				({
					name,
					label: name,
					description: name,
					parameters: { type: "object", properties: {} },
					execute: async () => {
						if (name === "write") writeRuns++;
						return { content: [{ type: "text", text: `${name} ran` }] };
					},
				}) as unknown as AgentTool;
			const mock = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", id: "w1", name: "write", arguments: {} }] },
					{ content: ["ok"] },
				],
			});
			const agent = new Agent({
				streamFn: mock.stream,
				// A dynamic (queue) choice must be filtered just like a per-run option.
				getToolChoice: () => forced,
				initialState: { model: mock, systemPrompt: [], tools: [tool("read"), tool("write")], messages: [] },
			});
			agent.setToolFilter(tools => tools.filter(candidate => candidate.name === "read"));

			await agent.prompt("go", { toolChoice: forced });

			for (const call of mock.calls) {
				expect(JSON.stringify(call.options?.toolChoice ?? null)).not.toContain("write");
				expect(call.context.tools?.map(candidate => candidate.name)).toEqual(["read"]);
			}
			expect(writeRuns).toBe(0);
		}
	});

	// ------------------------------------------------------------------ RT4 (plan 12)
	it("RT4) a shadow read (extension wrapper around a non-ReadTool) next to the real read disqualifies both", async () => {
		const m = groq();
		const runner = { hasHandlers: () => false } as unknown as ConstructorParameters<typeof ExtensionToolWrapper>[1];
		const variants: Array<{ label: string; tools: () => { tools: AgentTool[]; shadowRuns: () => number } }> = [
			{
				label: "wrapped name-alike",
				tools: () => {
					const shadow = counted("read");
					return {
						tools: [
							counted("write").tool,
							new ExtensionToolWrapper(readTool(), runner) as AgentTool,
							new ExtensionToolWrapper(shadow.tool, runner) as AgentTool,
						],
						shadowRuns: shadow.runs,
					};
				},
			},
			{
				label: "customWireName shadow",
				tools: () => {
					const shadow = counted("notes", { customWireName: "read" } as Partial<AgentTool>);
					return {
						tools: [
							counted("write").tool,
							readTool(),
							new ExtensionToolWrapper(shadow.tool, runner) as AgentTool,
						],
						shadowRuns: shadow.runs,
					};
				},
			},
		];
		for (const variant of variants) {
			const reopened = await interruptedSession(
				[
					{ role: "user", content: "update", timestamp: Date.now() },
					assistantWithCalls(m, [{ id: "w1", name: "write" }]),
				],
				m,
			);
			const log = installReplies([]);
			const { tools, shadowRuns } = variant.tools();
			const live = restartWith(reopened, { model: m, tools });

			await expect(live.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
			expect(log.bodies).toHaveLength(0);
			expect(shadowRuns()).toBe(0);
			expect(markerCount(live)).toBe(0);
			await live.dispose();
			session = undefined;
			vi.restoreAllMocks();
		}
	});

	// ------------------------------------------------------------------ RT5 (plan 5/6)
	it("RT5a) in process: a resumed run that fails again after a visible prefix never resumes a second time", async () => {
		const m = groq();
		const write = counted("write");
		// Tool loop, 4 transient failures, then every later request shows a prefix and drops.
		const log = installReplies(
			[toolCallReply(m.id, "w1", "write"), status503, status503, status503, status503],
			prefixThenDrop(m.id, "Partial answer, "),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()] });
		const live = session;
		const seen = events(live);

		await live.prompt("write then answer");
		await settle(live, () => log.bodies.length >= 6);
		await Bun.sleep(100);
		await live.waitForIdle();

		const resumeBodies = log.bodies.filter(body => body.includes(RESUME_FULL_TEXT));
		expect(markerCount(live)).toBe(1);
		expect(write.runs()).toBe(1);
		// One tool step plus the shared 7-request step budget, whatever the resumed run does.
		expect(log.bodies.length).toBeLessThanOrEqual(1 + 7);
		expect(resumeBodies.length).toBeGreaterThanOrEqual(1);
		expect(
			seen.filter(event => event.type === "notice" && event.message.startsWith("Resuming the interrupted step")),
		).toHaveLength(1);
		const before = log.bodies.length;
		await Bun.sleep(100);
		expect(log.bodies.length).toBe(before);
	});

	it("RT5b) restart: an endlessly failing resume spends at most 2 requests, and a second restart sends nothing", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const file = reopened.getSessionFile();
		if (!file) throw new Error("expected session file");
		const log = installReplies([], prefixThenDrop(m.id, "Partial answer, "));
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, {
			model: m,
			tools: [write.tool, readTool()],
			settings: { "retry.maxRetries": 99 },
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);
		await Bun.sleep(100);
		await live.waitForIdle();

		expect(log.bodies.length).toBeGreaterThanOrEqual(1);
		expect(log.bodies.length).toBeLessThanOrEqual(2);
		expect(write.runs()).toBe(0);
		expect(markerCount(live)).toBe(1);
		await live.sessionManager.flush();
		await live.dispose();
		session = undefined;

		// Second process start on the same file: the durable marker forbids another resume.
		const again = await SessionManager.open(file);
		const sentBefore = log.bodies.length;
		const second = restartWith(again, { model: m, tools: [write.tool, readTool()] });
		await expect(second.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
		await Bun.sleep(20);
		expect(log.bodies.length).toBe(sentBefore);
		expect(write.runs()).toBe(0);
	});

	// ------------------------------------------------------------------ RT6 (plan 16)
	it("RT6a) retry.autoResume=false: in process, the step fails exactly as before with no resume", async () => {
		const m = groq();
		const write = counted("write");
		const log = installReplies([toolCallReply(m.id, "w1", "write")], status503);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()], settings: { "retry.autoResume": false } });
		const seen = events(session);

		await session.prompt("write then answer");
		await settle(session);
		await Bun.sleep(100);
		await session.waitForIdle();

		// Tool step + initial attempt + 3 retries; nothing after.
		expect(log.bodies).toHaveLength(5);
		expect(log.bodies.some(body => body.includes(RESUME_FULL_TEXT))).toBe(false);
		expect(markerCount(session)).toBe(0);
		expect(seen.some(event => event.type === "notice" && event.message.startsWith("Resuming"))).toBe(false);
		const last = session.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("error");
	});

	it("RT6b) retry.autoResume=false: a restart with an unfinished step sends nothing and writes no marker", async () => {
		const m = groq();
		for (const tail of ["toolCall", "user"] as const) {
			const messages: AgentMessage[] = [{ role: "user", content: "update", timestamp: Date.now() }];
			if (tail === "toolCall") messages.push(assistantWithCalls(m, [{ id: "w1", name: "write" }]));
			const reopened = await interruptedSession(messages, m);
			const log = installReplies([]);
			const live = restartWith(reopened, {
				model: m,
				tools: [counted("write").tool, readTool()],
				settings: { "retry.autoResume": false },
			});
			await expect(live.continuePersistedHistory()).rejects.toThrow("interrupted during automatic recovery");
			expect(log.bodies).toHaveLength(0);
			expect(markerCount(live)).toBe(0);
			await live.dispose();
			session = undefined;
			vi.restoreAllMocks();
		}
	});

	// ------------------------------------------------------------------ RT7 (plan 8)
	it("RT7) three consecutive no-output first-event timeouts after a tool step stop the wire and never resume", async () => {
		const m = groq();
		const write = counted("write");
		let calls = 0;
		const log = installReplies([toolCallReply(m.id, "w1", "write")], textReply(m.id, "never"));
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			tools: [write.tool, readTool()],
			// The retry cap is far above the stall breaker, so only the breaker can stop the step.
			settings: { "retry.maxRetries": 6 },
			streamFn: (requested, context, options) => {
				calls++;
				if (calls === 1) return streamSimple(requested, context, options);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requested.api,
						provider: requested.provider,
						model: requested.id,
						usage: zeroUsage,
						stopReason: "error",
						errorMessage: "Groq stream timed out while waiting for the first event",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const seen = events(session);

		await session.prompt("write then answer");
		await settle(session);
		await Bun.sleep(100);
		await session.waitForIdle();

		expect(write.runs()).toBe(1);
		// One real tool request; then exactly three silent attempts and nothing else.
		expect(log.bodies).toHaveLength(1);
		expect(calls).toBe(1 + 3);
		expect(markerCount(session)).toBe(0);
		expect(seen.some(event => event.type === "notice" && event.message.startsWith("Resuming"))).toBe(false);
		expect(
			seen.some(
				event => event.type === "notice" && event.message.includes("3 consecutive timeouts without any output"),
			),
		).toBe(true);
	});

	// ------------------------------------------------------------------ RT8 (plan 14)
	it("RT8a) a follow-up queued right after the resume is scheduled wins; the resume sends nothing", async () => {
		const m = groq();
		const write = counted("write");
		const log = installReplies(
			[toolCallReply(m.id, "w1", "write"), status503, status503, status503, status503],
			textReply(m.id, "answered the new question"),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()] });
		const live = session;
		let queued = false;
		let busyError: unknown;
		live.subscribe(event => {
			if (event.type !== "notice" || !event.message.startsWith("Resuming the interrupted step") || queued) return;
			queued = true;
			// A direct prompt is refused while the failed run settles; UIs queue the input instead.
			live.prompt("REJECTED").catch(error => {
				busyError = error;
			});
			void live.followUp("NEW-QUESTION");
		});

		await live.prompt("write then answer");
		await settle(live, () => queued);
		await Bun.sleep(100);
		await live.waitForIdle();

		expect(queued).toBe(true);
		expect(String(busyError)).toContain("AgentBusyError");
		expect(write.runs()).toBe(1);
		const resumeBodies = log.bodies.filter(
			body => body.includes(RESUME_FULL_TEXT) || body.includes(RESUME_RESTRICTED_TEXT),
		);
		expect(resumeBodies).toHaveLength(0);
		// Tool step + initial attempt + 3 retries; the resume admitted nothing.
		expect(log.bodies).toHaveLength(5);
		// The user's input is kept for the user's next turn, never consumed by the skipped resume.
		expect(live.agent.hasQueuedMessages()).toBe(true);
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);
	});

	it("RT8b) an abort during the durable marker write sends nothing", async () => {
		const m = groq();
		const write = counted("write");
		const log = installReplies([toolCallReply(m.id, "w1", "write"), status503, status503, status503, status503]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({ model: m, tools: [write.tool, readTool()] });
		const live = session;
		const manager = live.sessionManager;
		const originalFlush = manager.flush.bind(manager);
		let aborted = false;
		vi.spyOn(manager, "flush").mockImplementation(async () => {
			const writingMarker = manager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === AUTO_RESUME_MARKER_CUSTOM_TYPE);
			if (writingMarker && !aborted) {
				aborted = true;
				await live.abort();
			}
			await originalFlush();
		});

		await live.prompt("write then answer");
		await settle(live);
		await Bun.sleep(50);
		await live.waitForIdle();

		expect(aborted).toBe(true);
		expect(log.bodies).toHaveLength(5);
		expect(write.runs()).toBe(1);
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);
	});

	// The abort lands in the preparation window of continuePersistedHistory
	// (after the resume notice, before agent.continue starts).
	it("RT8c) restart: a user abort landing before the resumed continuation starts sends nothing", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([], status503);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });
		const originalContinue = live.agent.continue.bind(live.agent);
		let abortedFirst = false;
		vi.spyOn(live.agent, "continue").mockImplementation(async (...args) => {
			if (!abortedFirst) {
				abortedFirst = true;
				// Esc pressed while the startup continuation was still being prepared.
				await live.abort();
			}
			return originalContinue(...args);
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);

		expect(abortedFirst).toBe(true);
		expect(write.runs()).toBe(0);
		expect(log.bodies.length).toBeLessThanOrEqual(2);
		expect(log.bodies).toHaveLength(0);
	});

	// On the restart path the notice fires before the send; a synchronous abort from a notice
	// subscriber must skip the resume, and the 2-request restart envelope must never be
	// replaced by a fresh default budget.
	it("RT8d) restart: an abort issued synchronously from the resume notice sends nothing (and never exceeds 2 requests)", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([], status503);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });
		live.subscribe(event => {
			if (event.type === "notice" && event.message.startsWith("Resuming the interrupted step")) void live.abort();
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);

		expect(write.runs()).toBe(0);
		// Restart envelope (Acceptance 4): never more than 2 requests, even when the abort is ignored.
		expect(log.bodies.length).toBeLessThanOrEqual(2);
		// Cancel race (plan test 14): an abort before the send admits nothing.
		expect(log.bodies).toHaveLength(0);
	});

	// ------------------------------------------------------------------ RT9 (abort after accepted resumed step)
	it("RT9) restart: an abort after the first resumed request succeeds into a tool call admits no next step", async () => {
		const m = groq();
		const write = counted("write");
		await Bun.write(path.join(tempDir.path(), "notes.txt"), "hello\n");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies(
			[toolCallReply(m.id, "r1", "read", { path: "notes.txt" }), textReply(m.id, "NEXT-TURN-ANSWER")],
			status503,
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });
		let abortedAt = -1;
		live.subscribe(event => {
			if (event.type === "tool_execution_start" && abortedAt < 0) {
				abortedAt = log.bodies.length;
				void live.abort();
			}
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);
		await Bun.sleep(100);
		await live.waitForIdle();

		expect(abortedAt).toBe(1);
		// Only the accepted resumed request went out; the step after the tool was never admitted.
		expect(log.bodies).toHaveLength(1);
		expect(log.bodies.length).toBeLessThanOrEqual(2);
		expect(log.bodies[0]).toContain(RESUME_RESTRICTED_TEXT);
		expect(toolNames(log.bodies[0])).toEqual(["read"]);
		expect(write.runs()).toBe(0);
		expect(markerCount(live)).toBe(1);
		const before = log.bodies.length;
		await Bun.sleep(100);
		expect(log.bodies.length).toBe(before);

		// The next user turn is ordinary: one request with the full tool view. The answered
		// resume instruction stays in history (an answered instruction is context), before the new turn.
		await live.prompt("next question");
		await settle(live);
		expect(log.bodies).toHaveLength(2);
		expect(toolNames(log.bodies[1])).toEqual(["read", "write"]);
		expect(occurrences(log.bodies[1], RESUME_RESTRICTED_TEXT)).toBe(1);
		expect(log.bodies[1].indexOf(RESUME_RESTRICTED_TEXT)).toBeLessThan(log.bodies[1].indexOf("next question"));
		expect(write.runs()).toBe(0);
		const last = live.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	// ------------------------------------------------------------------ RT10 (new prompt after skipped restart resume)
	it("RT10a) a new user prompt after a restart resume skipped by a notice abort is sent once with all tools", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([textReply(m.id, "FRESH-ANSWER")], status503);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });
		let noticed = false;
		live.subscribe(event => {
			if (event.type === "notice" && event.message.startsWith("Resuming the interrupted step") && !noticed) {
				noticed = true;
				void live.abort();
			}
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);
		expect(noticed).toBe(true);
		expect(log.bodies).toHaveLength(0);
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);

		await live.prompt("brand new question");
		await settle(live);
		await Bun.sleep(50);

		expect(log.bodies).toHaveLength(1);
		expect(toolNames(log.bodies[0])).toEqual(["read", "write"]);
		expect(log.bodies[0]).toContain("brand new question");
		expect(log.bodies[0]).not.toContain(RESUME_RESTRICTED_TEXT);
		expect(log.bodies[0]).not.toContain(RESUME_FULL_TEXT);
		expect(write.runs()).toBe(0);
		const last = live.agent.state.messages.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(last.stopReason).toBe("stop");
	});

	it("RT10b) a new user prompt after a restart resume skipped in the preparation window is sent once with all tools", async () => {
		const m = groq();
		const write = counted("write");
		const reopened = await interruptedSession(
			[
				{ role: "user", content: "update", timestamp: Date.now() },
				assistantWithCalls(m, [{ id: "w1", name: "write" }]),
			],
			m,
		);
		const log = installReplies([textReply(m.id, "FRESH-ANSWER")], status503);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const live = restartWith(reopened, { model: m, tools: [write.tool, readTool()] });
		const originalContinue = live.agent.continue.bind(live.agent);
		let abortedFirst = false;
		vi.spyOn(live.agent, "continue").mockImplementation(async (...args) => {
			if (!abortedFirst) {
				abortedFirst = true;
				await live.abort();
			}
			return originalContinue(...args);
		});

		await live.continuePersistedHistory().catch(() => undefined);
		await settle(live);
		expect(abortedFirst).toBe(true);
		expect(log.bodies).toHaveLength(0);
		expect(live.getActiveToolNames().sort()).toEqual(["read", "write"]);

		await live.prompt("brand new question");
		await settle(live);
		await Bun.sleep(50);

		expect(log.bodies).toHaveLength(1);
		expect(toolNames(log.bodies[0])).toEqual(["read", "write"]);
		expect(write.runs()).toBe(0);
		// The never-answered restricted instruction must not reach the model on the new turn.
		expect(log.bodies[0]).not.toContain(RESUME_RESTRICTED_TEXT);
	});
});
