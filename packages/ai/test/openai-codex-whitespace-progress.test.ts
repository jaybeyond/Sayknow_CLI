import { afterEach, describe, expect, it } from "bun:test";
import {
	createCodexSemanticProgressClassifier,
	streamOpenAICodexResponses,
} from "@sayknow-cli/ai/providers/openai-codex-responses";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@sayknow-cli/ai/types";
import { getAgentDir, setAgentDir, TempDir } from "@sayknow-cli/utils";

const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();

afterEach(() => {
	global.fetch = originalFetch;
	setAgentDir(originalAgentDir);
});

const STALL_MESSAGE = "Provider stream stalled while waiting for the next event";
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function sseModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	};
}

function codexContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Plan", timestamp: Date.now() }],
	};
}

function requestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	if (input instanceof Request) return input.signal;
	return undefined;
}

type SseFrame = Record<string, unknown> | Array<Record<string, unknown>>;

/** Emits the first frame at once and each later frame `intervalMs` apart; never closes on its own. */
function installPacedSse(frames: SseFrame[], intervalMs: number): void {
	global.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const signal = requestSignal(input, init);
		const encoder = new TextEncoder();
		const timers: NodeJS.Timeout[] = [];
		const stop = () => {
			for (const timer of timers) clearTimeout(timer);
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				frames.forEach((frame, index) => {
					timers.push(
						setTimeout(() => {
							for (const event of Array.isArray(frame) ? frame : [frame]) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							}
						}, index * intervalMs),
					);
				});
				signal?.addEventListener(
					"abort",
					() => {
						stop();
						controller.error(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
					},
					{ once: true },
				);
			},
			cancel: stop,
		});
		return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
	}) as typeof fetch;
}

function functionCallStart(id: string): Record<string, unknown> {
	return {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "todo_write", arguments: "" },
	};
}

function argumentsDelta(id: string, delta: string): Record<string, unknown> {
	return { type: "response.function_call_arguments.delta", item_id: `fc_${id}`, delta };
}

function functionCallCompletion(id: string, args: string): Array<Record<string, unknown>> {
	return [
		{ type: "response.function_call_arguments.done", item_id: `fc_${id}`, arguments: args },
		{
			type: "response.output_item.done",
			item: { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "todo_write", arguments: args },
		},
		{ type: "response.completed", response: { status: "completed", usage: USAGE } },
	];
}

function startEvent(partial: AssistantMessage, contentIndex: number): AssistantMessageEvent {
	return { type: "toolcall_start", contentIndex, partial };
}

function deltaEvent(partial: AssistantMessage, contentIndex: number, delta: string): AssistantMessageEvent {
	return { type: "toolcall_delta", contentIndex, delta, partial };
}

function partialWith(block: ToolCall): AssistantMessage {
	return { role: "assistant", content: [block] } as unknown as AssistantMessage;
}

describe("Codex semantic progress classifier", () => {
	const functionBlock: ToolCall = { type: "toolCall", id: "call_1", name: "todo_write", arguments: {} };

	it("treats trailing whitespace after complete tool arguments as non-progress", () => {
		const isProgress = createCodexSemanticProgressClassifier();
		const partial = partialWith(functionBlock);
		expect(isProgress(startEvent(partial, 0))).toBe(false);
		expect(isProgress(deltaEvent(partial, 0, '{"ops":[]}'))).toBe(true);
		expect(isProgress(deltaEvent(partial, 0, " \t"))).toBe(false);
		expect(isProgress(deltaEvent(partial, 0, "\n"))).toBe(false);
	});

	it("treats whitespace inside incomplete or malformed tool arguments as progress", () => {
		const isProgress = createCodexSemanticProgressClassifier();
		const partial = partialWith(functionBlock);
		expect(isProgress(deltaEvent(partial, 0, '{"ops":'))).toBe(true);
		expect(isProgress(deltaEvent(partial, 0, " \t"))).toBe(true);
		const malformed = createCodexSemanticProgressClassifier();
		expect(malformed(deltaEvent(partial, 0, '{"ops":]'))).toBe(true);
		expect(malformed(deltaEvent(partial, 0, " \t"))).toBe(true);
	});

	it("keeps whitespace progress for custom tool input, text, and reasoning", () => {
		const isProgress = createCodexSemanticProgressClassifier();
		const custom = partialWith({ ...functionBlock, customWireName: "apply_patch" });
		expect(isProgress(deltaEvent(custom, 0, "{}"))).toBe(true);
		expect(isProgress(deltaEvent(custom, 0, " \t"))).toBe(true);
		const partial = partialWith(functionBlock);
		expect(isProgress({ type: "text_delta", contentIndex: 0, delta: " ", partial })).toBe(true);
		expect(isProgress({ type: "thinking_delta", contentIndex: 0, delta: " ", partial })).toBe(true);
	});

	it("restarts the argument buffer when a tool call starts again at the same index", () => {
		const isProgress = createCodexSemanticProgressClassifier();
		const partial = partialWith(functionBlock);
		expect(isProgress(deltaEvent(partial, 0, "{}"))).toBe(true);
		expect(isProgress(startEvent(partial, 0))).toBe(false);
		expect(isProgress(deltaEvent(partial, 0, '{"ops":'))).toBe(true);
		expect(isProgress(deltaEvent(partial, 0, " "))).toBe(true);
	});
});

describe("Codex SSE whitespace progress", () => {
	it("stalls out when only whitespace follows complete tool arguments", async () => {
		setAgentDir(TempDir.createSync("@skc-codex-whitespace-").path());
		installPacedSse(
			[
				{ type: "response.created", response: { id: "resp_whitespace", status: "in_progress" } },
				functionCallStart("trailing"),
				argumentsDelta("trailing", '{"ops":[]}'),
				...Array.from({ length: 1000 }, () => argumentsDelta("trailing", " \t")),
			],
			10,
		);
		const startedAt = Date.now();
		const result = await streamOpenAICodexResponses(sseModel(), codexContext(), {
			apiKey: codexToken(),
			streamIdleTimeoutMs: 60,
			streamMaxRetries: 0,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(STALL_MESSAGE);
		// Without the classifier every whitespace delta resets the idle window and
		// the turn only ends when the provider stops (here ~10 s later).
		expect(Date.now() - startedAt).toBeLessThan(2000);
	}, 20_000);

	it("keeps streaming while whitespace arrives inside incomplete tool arguments", async () => {
		setAgentDir(TempDir.createSync("@skc-codex-whitespace-").path());
		installPacedSse(
			[
				functionCallStart("open"),
				argumentsDelta("open", '{"ops":'),
				...Array.from({ length: 6 }, () => argumentsDelta("open", " \t")),
				[argumentsDelta("open", "[]}"), ...functionCallCompletion("open", '{"ops": \t \t \t \t \t \t[]}')],
			],
			25,
		);
		const result = await streamOpenAICodexResponses(sseModel(), codexContext(), {
			apiKey: codexToken(),
			streamIdleTimeoutMs: 60,
			streamMaxRetries: 0,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			expect.objectContaining({ type: "toolCall", name: "todo_write", arguments: { ops: [] } }),
		]);
	}, 20_000);
});
