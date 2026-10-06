import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@sayknow-cli/ai/providers/anthropic";
import { streamGoogleGeminiCli } from "@sayknow-cli/ai/providers/google-gemini-cli";
import { streamOpenAICodexResponses } from "@sayknow-cli/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@sayknow-cli/ai/types";
import { getAgentDir, setAgentDir, TempDir } from "@sayknow-cli/utils";
import { createSseResponse } from "./openai-tool-choice-test-helpers";

/**
 * Provider-local resend edges: a server Retry-After beyond the caller's cap must not be
 * replayed by the provider loop, a managed Gemini empty stream must not be resent, and a
 * pre-aborted Codex websocket request must neither admit nor send.
 */

const originalWebSocket = global.WebSocket;
const originalFetch = global.fetch;
const originalAgentDir = getAgentDir();

afterEach(() => {
	global.WebSocket = originalWebSocket;
	global.fetch = originalFetch;
	setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function anthropic429(retryAfterSeconds: string): Response {
	return new Response(
		JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited" } }),
		{
			status: 429,
			headers: { "content-type": "application/json", "retry-after": retryAfterSeconds },
		},
	);
}

function anthropicSuccess(text: string): Response {
	const events: Array<Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: "msg_ok",
				type: "message",
				role: "assistant",
				model: anthropicModel.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_ok" } });
}

describe("anthropic provider retry honors Retry-After", () => {
	it("does not replay a 429 whose Retry-After exceeds the delay cap", async () => {
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			return anthropic429("3600");
		};

		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 0,
		}).result();

		expect(fetchCalls).toBe(1);
		expect(wait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});

	it("treats maxRetryDelayMs as the cap for Retry-After", async () => {
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			return fetchCalls === 1 ? anthropic429("5") : anthropicSuccess("late");
		};

		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 0,
			maxRetryDelayMs: 4_000,
		}).result();

		expect(fetchCalls).toBe(1);
		expect(wait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
	});

	it("still retries a short Retry-After using the larger of Retry-After and backoff", async () => {
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			return fetchCalls === 1 ? anthropic429("5") : anthropicSuccess("recovered");
		};

		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 0,
		}).result();

		expect(fetchCalls).toBe(2);
		expect(wait).toHaveBeenCalledTimes(1);
		expect(wait.mock.calls[0]?.[0]).toBe(5_000);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("keeps the exponential backoff when Retry-After is shorter", async () => {
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			return fetchCalls === 1 ? anthropic429("1") : anthropicSuccess("recovered");
		};

		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			requestMaxRetries: 0,
		}).result();

		expect(fetchCalls).toBe(2);
		expect(wait).toHaveBeenCalledTimes(1);
		expect(wait.mock.calls[0]?.[0]).toBe(2_000);
		expect(result.stopReason).toBe("stop");
	});
});

const geminiModel: Model<"google-gemini-cli"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: "https://gemini-cli.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function emptyGeminiStream(): Response {
	const response = createSseResponse([]);
	Object.defineProperty(response, "url", { value: "https://gemini-cli.example.test/stream" });
	return response;
}

async function runEmptyGemini(fallbackManaged: boolean): Promise<{ requests: number; errorMessage?: string }> {
	vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
	let requests = 0;
	const result = await streamGoogleGeminiCli(geminiModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "project" }),
		fallbackManaged,
		fetch: async () => {
			requests += 1;
			return emptyGeminiStream();
		},
	}).result();
	expect(result.stopReason).toBe("error");
	return { requests, errorMessage: result.errorMessage };
}

describe("google-gemini-cli empty stream resend", () => {
	it("resends an empty stream through options.fetch when unmanaged", async () => {
		const { requests, errorMessage } = await runEmptyGemini(false);
		expect(requests).toBe(3);
		expect(errorMessage).toContain("empty response");
	});

	it("never resends an empty stream on a managed attempt", async () => {
		const { requests, errorMessage } = await runEmptyGemini(true);
		expect(requests).toBe(1);
		expect(errorMessage).toContain("empty response");
	});

	it("does not retry a retryable HTTP failure inside fetchWithRetry on a managed attempt", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const result = await streamGoogleGeminiCli(geminiModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "project" }),
			fallbackManaged: true,
			fetch: async () => {
				requests += 1;
				return new Response(JSON.stringify({ error: { code: 503, message: "unavailable" } }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			},
		}).result();
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
	});
});

function createCodexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const codexModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.3-codex-spark",
	name: "GPT-5.3 Codex Spark",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	preferWebsockets: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 128000,
};

type WsEventType = "open" | "message" | "error" | "close";

/** Minimal global `WebSocket` stand-in; production wires `on{type}` handler properties. */
class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: Record<string, string> },
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	emit(type: WsEventType, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	sendJson(payload: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(payload) } as unknown as MessageEvent);
	}

	emitCodexResponse(responseId: string, text: string): void {
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: "response.done",
			response: {
				id: responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		});
	}
}

describe("openai-codex websocket pre-aborted request", () => {
	it("neither admits nor sends when the caller aborts as the socket opens", async () => {
		setAgentDir(TempDir.createSync("@pi-provider-retry-edges-").path());
		const fetchMock = vi.fn(async () => new Response("unexpected SSE"));
		global.fetch = fetchMock as unknown as typeof fetch;
		const controller = new AbortController();
		let frameSends = 0;
		class AbortOnOpenWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				setTimeout(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
					// Abort lands in the same tick the socket opens, before the request frame is admitted.
					controller.abort();
				}, 0);
			}
			send(): void {
				frameSends += 1;
				this.emitCodexResponse("resp_leak", "leak");
			}
		}
		global.WebSocket = AbortOnOpenWebSocket as unknown as typeof WebSocket;
		const onUpstreamRequest = vi.fn();

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: createCodexTestToken(),
			sessionId: "ws-abort-on-open",
			preferWebsockets: true,
			providerSessionState: new Map<string, ProviderSessionState>(),
			signal: controller.signal,
			onUpstreamRequest,
		}).result();

		expect(onUpstreamRequest).not.toHaveBeenCalled();
		expect(frameSends).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("aborted");
	});

	it("neither admits nor sends on a reused socket when the caller is already aborted", async () => {
		setAgentDir(TempDir.createSync("@pi-provider-retry-edges-").path());
		const fetchMock = vi.fn(async () => new Response("unexpected SSE"));
		global.fetch = fetchMock as unknown as typeof fetch;
		let sockets = 0;
		let frameSends = 0;
		class ReusableWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: Record<string, string> }) {
				super(url, options);
				sockets += 1;
				setTimeout(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				}, 0);
			}
			send(): void {
				frameSends += 1;
				this.emitCodexResponse(`resp_${frameSends}`, "Hello");
			}
		}
		global.WebSocket = ReusableWebSocket as unknown as typeof WebSocket;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const onUpstreamRequest = vi.fn();
		const options = {
			apiKey: createCodexTestToken(),
			sessionId: "ws-reuse-pre-aborted",
			preferWebsockets: true,
			providerSessionState,
			onUpstreamRequest,
		};

		const first = await streamOpenAICodexResponses(codexModel, context, options).result();
		expect(first.stopReason).toBe("stop");
		expect(onUpstreamRequest).toHaveBeenCalledTimes(1);
		expect(frameSends).toBe(1);

		const aborted = new AbortController();
		aborted.abort();
		const second = await streamOpenAICodexResponses(codexModel, context, {
			...options,
			signal: aborted.signal,
		}).result();

		expect(second.stopReason).toBe("aborted");
		expect(onUpstreamRequest).toHaveBeenCalledTimes(1);
		expect(frameSends).toBe(1);
		expect(sockets).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
