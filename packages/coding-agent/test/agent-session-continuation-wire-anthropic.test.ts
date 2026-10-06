import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool, ThinkingLevel } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, streamSimple } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

/** Outbound Anthropic Messages JSON exactly as the production serializer wrote it. */
interface WireBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	data?: string;
}

interface WireMessage {
	role: string;
	content: string | WireBlock[];
}

interface WireBody {
	model: string;
	system?: unknown;
	thinking?: unknown;
	messages: WireMessage[];
}

type WireReply = () => Response;

const CONTINUATION_MARKER = "Continue directly from where it stops";
const SYSTEM_REMINDER = "<system-reminder>";
/** Failure-only fields that must never leak from the transcript into the request body. */
const FAILURE_METADATA = ["errorMessage", "stopReason", "transportFailure", "errorStatus", "errorKind", "terminated"];

function wireBlocks(content: WireMessage["content"]): WireBlock[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function wireText(content: WireMessage["content"]): string {
	return wireBlocks(content)
		.map(block => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
		.join("");
}

/** A user turn whose content is only `<system-reminder>` text blocks (the volatile project-context turn). */
function isVolatileReminderTurn(message: WireMessage): boolean {
	if (message.role !== "user") return false;
	const blocks = wireBlocks(message.content);
	return (
		blocks.length > 0 &&
		blocks.every(block => block.type === "text" && (block.text ?? "").trimStart().startsWith(SYSTEM_REMINDER))
	);
}

/** Anthropic carries the system prompt in `body.system`; drop only the volatile reminder turn. */
function withoutSystem(body: WireBody): WireMessage[] {
	return body.messages.filter(message => !isVolatileReminderTurn(message));
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function sseFrame(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(model: string, id: string): string {
	return sseFrame("message_start", {
		type: "message_start",
		message: {
			id,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
}

function textBlockStart(index: number): string {
	return sseFrame("content_block_start", {
		type: "content_block_start",
		index,
		content_block: { type: "text", text: "" },
	});
}

function textDelta(index: number, text: string): string {
	return sseFrame("content_block_delta", {
		type: "content_block_delta",
		index,
		delta: { type: "text_delta", text },
	});
}

function completedTail(index: number): string[] {
	return [
		sseFrame("content_block_stop", { type: "content_block_stop", index }),
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 4 },
		}),
		sseFrame("message_stop", { type: "message_stop" }),
	];
}

/**
 * Streams SSE frames one read at a time. `disconnect` errors the body on the read
 * after the last frame, like a socket closed mid-answer (undici/Bun "terminated").
 */
function sseReply(frames: readonly string[], end: "close" | "disconnect"): WireReply {
	return () => {
		const encoder = new TextEncoder();
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
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_continuation_wire" },
		});
	};
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return String(input);
}

/**
 * Replaces only the network edge. The Anthropic SDK client resolves `fetch` per
 * request, so every captured body went through the real admission wrapper and
 * anthropic-messages serializer before reaching this stub.
 */
function installWire(replies: readonly WireReply[]): WireBody[] {
	const bodies: WireBody[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		const url = requestUrl(input);
		if (!new URL(url).pathname.endsWith("/v1/messages")) throw new Error(`Unexpected outbound request: ${url}`);
		if (typeof init?.body !== "string") throw new Error("Expected a serialized JSON request body");
		bodies.push(JSON.parse(init.body) as WireBody);
		const reply = replies[bodies.length - 1];
		if (!reply) throw new Error(`Unexpected outbound request #${bodies.length}`);
		return reply();
	}) as typeof fetch);
	return bodies;
}

describe("AgentSession visible continuation over the real anthropic-messages wire", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-continuation-wire-anthropic-");
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
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		expect(model.api).toBe("anthropic-messages");
		return model;
	}

	function buildWireSession(tools: AgentTool[] = []): AgentSession {
		const model = wireModel();
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
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
		// Thinking off: a plain-text prefix is the only replay-safe projection under test.
		settings.setModelRole("default", `${model.provider}/${model.id}:off`);
		const built = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		built.setThinkingLevel(ThinkingLevel.Off);
		return built;
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
		// The shared <turn-aborted> guidance is static text (it is a `developer` turn on OpenAI wires).
		const serialized = JSON.stringify(
			withoutSystem(body).filter(message => !wireText(message.content).trimStart().startsWith("<turn-aborted>")),
		);
		for (const field of FAILURE_METADATA) expect(serialized).not.toContain(field);
	}

	it("continues a disconnected plain-text answer with the exact prefix on the wire", async () => {
		const model = wireModel();
		const prefix = "Three findings: one,";
		const rest = " two, three.";
		const bodies = installWire([
			sseReply(
				[messageStart(model.id, "msg_continuation_first"), textBlockStart(0), textDelta(0, prefix)],
				"disconnect",
			),
			sseReply(
				[
					messageStart(model.id, "msg_continuation_second"),
					textBlockStart(0),
					textDelta(0, rest),
					...completedTail(0),
				],
				"close",
			),
		]);
		session = buildWireSession();
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
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
		// Thinking is off on both attempts: no extended-thinking request parameter.
		expect(bodies[0]!.thinking).toBeUndefined();
		expect(bodies[1]!.thinking).toBeUndefined();

		// First request: the user prompt only (system prompt lives in `body.system`).
		expect(withoutSystem(bodies[0]!).map(message => [message.role, wireText(message.content)])).toEqual([
			["user", "report"],
		]);

		// Continuation request: [user, assistant(prefix verbatim), user(shared <turn-aborted>
		// guidance that transformMessages adds after any interrupted assistant), user(continuation)].
		const resent = bodies[1]!;
		expect(resent.model).toBe(model.id);
		const allTurns = withoutSystem(resent);
		expect(allTurns.map(message => message.role)).toEqual(["user", "assistant", "user", "user"]);
		expect(wireText(allTurns[2]!.content).trimStart().startsWith("<turn-aborted>")).toBe(true);
		const turns = [allTurns[0]!, allTurns[1]!, allTurns[3]!];
		expect(wireText(turns[0]!.content)).toBe("report");

		// The prefix is neither duplicated nor edited, and carries no thinking/signature blocks.
		const assistantBlocks = wireBlocks(turns[1]!.content);
		expect(assistantBlocks.map(block => block.type)).toEqual(["text"]);
		expect(assistantBlocks[0]!.text).toBe(prefix);
		expect(assistantBlocks.some(block => block.signature !== undefined || block.thinking !== undefined)).toBe(false);
		expect(JSON.stringify(turns[1])).not.toContain("signature");
		expect(JSON.stringify(turns[1])).not.toContain("thinking");

		const continuation = wireText(turns[2]!.content);
		expect(continuation).toContain(CONTINUATION_MARKER);
		expect(occurrences(continuation, CONTINUATION_MARKER)).toBe(1);
		expect(occurrences(JSON.stringify(resent.messages), prefix)).toBe(1);
		expect(occurrences(JSON.stringify(resent.messages), CONTINUATION_MARKER)).toBe(1);
		expectNoFailureMetadata(resent);

		// Public output: the prefix and the continued delta each appear exactly once.
		expect(deltas.join("")).toBe(prefix + rest);
		const transcript = assistants(session);
		expect(transcript.map(message => message.content)).toEqual([
			[{ type: "text", text: prefix }],
			[{ type: "text", text: rest }],
		]);
		expect(
			transcript
				.flatMap(message => message.content)
				.map(block => (block.type === "text" ? block.text : ""))
				.join(""),
		).toBe(prefix + rest);
	});
});
