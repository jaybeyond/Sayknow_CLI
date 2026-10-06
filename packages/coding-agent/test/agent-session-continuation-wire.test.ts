import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, streamSimple } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";

/** Outbound OpenAI chat-completions JSON exactly as the production serializer wrote it. */
interface WireToolCall {
	id: string;
	type: string;
	function: { name: string; arguments: string };
}

interface WireMessage {
	role: string;
	content?: string | Array<{ type: string; text?: string }> | null;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
}

interface WireBody {
	model: string;
	messages: WireMessage[];
}

type WireReply = () => Response;

const CONTINUATION_MARKER = "Continue directly from where it stops";
/** Failure-only fields that must never leak from the transcript into the request body. */
const FAILURE_METADATA = ["errorMessage", "stopReason", "transportFailure", "errorStatus", "errorKind", "terminated"];

function wireText(content: WireMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content.map(part => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("");
}

/** Drops system prompts and the session's volatile `<system-reminder>` project-context turn. */
function withoutSystem(body: WireBody): WireMessage[] {
	return body.messages.filter(
		message =>
			message.role !== "system" &&
			message.role !== "developer" &&
			!(message.role === "user" && wireText(message.content).trimStart().startsWith("<system-reminder>")),
	);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function chunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
	return {
		id: "chatcmpl-continuation-wire",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

/**
 * Streams SSE frames one read at a time. `disconnect` errors the body after the
 * last frame was delivered, like a socket closed mid-answer (undici/Bun "terminated").
 */
function sseReply(chunks: readonly object[], end: "done" | "disconnect"): WireReply {
	return () => {
		const encoder = new TextEncoder();
		const frames = chunks.map(item => `data: ${JSON.stringify(item)}\n\n`);
		if (end === "done") frames.push("data: [DONE]\n\n");
		let next = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (next < frames.length) {
						controller.enqueue(encoder.encode(frames[next++]));
						return;
					}
					if (end === "disconnect") controller.error(new TypeError("terminated"));
					else controller.close();
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

/**
 * Replaces only the network edge. The production admission wrapper captures
 * `globalThis.fetch` per request, so every captured body went through the real
 * lease/admission + openai-completions serializer before reaching this stub.
 */
function installWire(replies: readonly WireReply[]): WireBody[] {
	const bodies: WireBody[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.endsWith("/chat/completions")) throw new Error(`Unexpected outbound request: ${url}`);
		if (typeof init?.body !== "string") throw new Error("Expected a serialized JSON request body");
		bodies.push(JSON.parse(init.body) as WireBody);
		const reply = replies[bodies.length - 1];
		if (!reply) throw new Error(`Unexpected outbound request #${bodies.length}`);
		return reply();
	}) as typeof fetch);
	return bodies;
}

describe("AgentSession visible continuation over the real openai-completions wire", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-continuation-wire-");
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

	function wireModel() {
		const model = getBundledModel("groq", "llama-3.3-70b-versatile");
		if (!model) throw new Error("Expected bundled Groq test model to exist");
		expect(model.api).toBe("openai-completions");
		return model;
	}

	function buildWireSession(tools: AgentTool[] = []): AgentSession {
		const model = wireModel();
		authStorage.setRuntimeApiKey(model.provider, `${model.provider}-test-key`);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			// Production transport + converter (sdk/session.ts): no custom stream function.
			streamFn: streamSimple,
			convertToLlm,
		});
		const settings = Settings.isolated({
			"fallback.auto": false,
			"compaction.enabled": false,
			// Bare defaults admit only watchdog wording; a dropped connection ("terminated")
			// is recovered under an explicit transient retry policy.
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 10,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		return new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
	}

	function countRetryStarts(s: AgentSession): { starts: number } {
		const counter = { starts: 0 };
		s.subscribe(event => {
			if (event.type === "auto_retry_start") counter.starts++;
		});
		return counter;
	}

	function assistants(s: AgentSession): AssistantMessage[] {
		return s.agent.state.messages.filter((message): message is AssistantMessage => message.role === "assistant");
	}

	function expectNoFailureMetadata(body: WireBody): void {
		// The volatile workspace-tree turn lists repo paths; only transcript turns can leak failures.
		const serialized = JSON.stringify(withoutSystem(body));
		for (const field of FAILURE_METADATA) expect(serialized).not.toContain(field);
	}

	it("continues a disconnected plain-text answer with the exact prefix on the wire", async () => {
		const model = wireModel();
		const prefix = "Three findings: one,";
		const rest = " two, three.";
		const bodies = installWire([
			sseReply([chunk(model.id, { role: "assistant" }), chunk(model.id, { content: prefix })], "disconnect"),
			sseReply(
				[chunk(model.id, { role: "assistant" }), chunk(model.id, { content: rest }), chunk(model.id, {}, "stop")],
				"done",
			),
		]);
		session = buildWireSession();
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retries = countRetryStarts(session);
		const deltas: string[] = [];
		session.subscribe(event => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
		});

		await session.prompt("report");
		await session.waitForIdle();

		expect(bodies).toHaveLength(2);
		expect(retries.starts).toBe(1);

		// First request: (system?) + the user prompt, nothing else.
		expect(withoutSystem(bodies[0]!).map(message => [message.role, wireText(message.content)])).toEqual([
			["user", "report"],
		]);

		// Continuation request: [system, user, assistant(prefix verbatim), user(continuation)].
		const resent = bodies[1]!;
		expect(resent.model).toBe(model.id);
		const turns = withoutSystem(resent);
		expect(turns.map(message => message.role)).toEqual(["user", "assistant", "user"]);
		expect(wireText(turns[0]!.content)).toBe("report");
		// Exact object: the prefix is neither duplicated nor edited and carries no failure fields.
		expect(turns[1]).toEqual({ role: "assistant", content: prefix });
		expect(wireText(turns[2]!.content)).toContain(CONTINUATION_MARKER);
		expect(occurrences(JSON.stringify(resent.messages), prefix)).toBe(1);
		expect(occurrences(JSON.stringify(resent.messages), CONTINUATION_MARKER)).toBe(1);
		expectNoFailureMetadata(resent);

		// Public output: the prefix and the continued delta each appear exactly once.
		expect(deltas.join("")).toBe(prefix + rest);
		expect(assistants(session).map(message => message.content)).toEqual([
			[{ type: "text", text: prefix }],
			[{ type: "text", text: rest }],
		]);

		// Copy/RPC/print consumers see the whole visible answer, not only the continued tail.
		expect(session.getLastAssistantText()).toBe(prefix + rest);
		const last = assistants(session).at(-1)!;
		expect(session.getVisibleAnswerChain(last).map(message => message.content)).toEqual([
			[{ type: "text", text: prefix }],
			[{ type: "text", text: rest }],
		]);
	});

	it("continues after a completed tool and a public prefix without re-running the tool", async () => {
		const model = wireModel();
		const prefix = "Partial summary:";
		const rest = " all checks passed.";
		let toolRuns = 0;
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
		const bodies = installWire([
			// A2: tool_call c7.
			sseReply(
				[
					chunk(model.id, { role: "assistant" }),
					chunk(model.id, {
						tool_calls: [
							{ index: 0, id: "c7", type: "function", function: { name: "counted", arguments: "{}" } },
						],
					}),
					chunk(model.id, {}, "tool_calls"),
				],
				"done",
			),
			// A4: public text prefix, then the connection drops.
			sseReply([chunk(model.id, { role: "assistant" }), chunk(model.id, { content: prefix })], "disconnect"),
			// Continuation.
			sseReply(
				[chunk(model.id, { role: "assistant" }), chunk(model.id, { content: rest }), chunk(model.id, {}, "stop")],
				"done",
			),
		]);
		session = buildWireSession([countedTool]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retries = countRetryStarts(session);

		await session.prompt("inspect");
		await session.waitForIdle();

		expect(toolRuns).toBe(1);
		expect(bodies).toHaveLength(3);
		expect(retries.starts).toBe(1);

		// Request after T3 (the one that later drops) carries no continuation yet.
		const afterTool = withoutSystem(bodies[1]!);
		expect(afterTool.map(message => message.role)).toEqual(["user", "assistant", "tool"]);
		expect(JSON.stringify(bodies[1]!.messages)).not.toContain(CONTINUATION_MARKER);

		// Continuation request: U1, A2 tool_calls c7, T3 c7 result, A4 prefix, continuation user — in order.
		const resent = bodies[2]!;
		const turns = withoutSystem(resent);
		expect(turns.map(message => message.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(wireText(turns[0]!.content)).toBe("inspect");

		const toolCalls = turns[1]!.tool_calls ?? [];
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]!.id).toBe("c7");
		expect(toolCalls[0]!.type).toBe("function");
		expect(toolCalls[0]!.function.name).toBe("counted");
		expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({});

		expect(turns[2]).toMatchObject({ role: "tool", tool_call_id: "c7", content: "counted result" });
		expect(turns[3]).toEqual({ role: "assistant", content: prefix });
		expect(wireText(turns[4]!.content)).toContain(CONTINUATION_MARKER);

		const serialized = JSON.stringify(resent.messages);
		expect(occurrences(serialized, '"c7"')).toBe(2);
		expect(occurrences(serialized, prefix)).toBe(1);
		expect(occurrences(serialized, CONTINUATION_MARKER)).toBe(1);
		expectNoFailureMetadata(resent);

		const transcript = assistants(session);
		expect(transcript).toHaveLength(3);
		expect(transcript[0]!.content.some(block => block.type === "toolCall" && block.id === "c7")).toBe(true);
		expect(transcript[1]!.content).toEqual([{ type: "text", text: prefix }]);
		expect(transcript[2]!.content).toEqual([{ type: "text", text: rest }]);
		expect(
			session.agent.state.messages.filter(message => message.role === "toolResult" && message.toolCallId === "c7"),
		).toHaveLength(1);
	});
});
