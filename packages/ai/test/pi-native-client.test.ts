import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { streamPiNative } from "../src/providers/pi-native-client";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "../src/types";

function sseBytes(events: AssistantMessageEvent[]): Uint8Array {
	const encoder = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const event of events) {
		parts.push(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	}
	parts.push(encoder.encode("data: [DONE]\n\n"));
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function fakeBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function fakeResponse(events: AssistantMessageEvent[], init: ResponseInit = {}): Response {
	return new Response(fakeBody(sseBytes(events)), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
		...init,
	});
}

function baseAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function fakeModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://llm-gateway.internal:4000",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		transport: "pi-native",
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const out: AssistantMessageEvent[] = [];
	for await (const event of stream) out.push(event);
	return out;
}

afterEach(() => {
	mock.restore();
});

describe("streamPiNative request shape", () => {
	it("POSTs `{modelId, context, options, stream:true}` to `<baseUrl>/v1/pi/stream`", async () => {
		const final = baseAssistant();
		const captured: { url?: string; init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (input, init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: final }]);
		}) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			temperature: 0.7,
		});
		await stream.result();

		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
		expect(captured.init?.method).toBe("POST");
		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers.Accept).toBe("text/event-stream");
		expect(headers.Authorization).toBe("Bearer gw-bearer");

		const body = JSON.parse(captured.init?.body as string);
		expect(body.modelId).toBe("claude-sonnet-4-5");
		expect(body.context).toEqual(baseContext);
		expect(body.stream).toBe(true);
		expect(body.options.temperature).toBe(0.7);
	});

	it("strips non-wire fields (signal, apiKey, fetch, callbacks) from `options`", async () => {
		// `apiKey` must ride in the Authorization header, never the body — sending
		// it twice would let a logged request leak the gateway bearer. The other
		// fields are non-serializable function/runtime handles.
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		const controller = new AbortController();
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: () => undefined,
			onResponse: () => undefined,
			onSseEvent: () => undefined,
			providerSessionState: new Map(),
			maxTokens: 1024,
		});
		await stream.result();

		const body = JSON.parse(captured.init?.body as string);
		expect("apiKey" in body.options).toBe(false);
		expect("signal" in body.options).toBe(false);
		expect("fetch" in body.options).toBe(false);
		expect("onPayload" in body.options).toBe(false);
		expect("onResponse" in body.options).toBe(false);
		expect("onSseEvent" in body.options).toBe(false);
		expect("providerSessionState" in body.options).toBe(false);
		// And the legitimate options survive
		expect(body.options.maxTokens).toBe(1024);
	});

	it("normalizes trailing slashes on `baseUrl` so the endpoint never double-slashes", async () => {
		const captured: { url?: string } = {};
		const fetchImpl: FetchImpl = (async (input, _init) => {
			captured.url = typeof input === "string" ? input : input.toString();
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(fakeModel({ baseUrl: "http://llm-gateway.internal:4000///" }), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
		}).result();
		expect(captured.url).toBe("http://llm-gateway.internal:4000/v1/pi/stream");
	});

	it("forwards `model.headers` and lets a caller-supplied Authorization win", async () => {
		const captured: { init?: RequestInit } = {};
		const fetchImpl: FetchImpl = (async (_input, init) => {
			captured.init = init;
			return fakeResponse([{ type: "done", reason: "stop", message: baseAssistant() }]);
		}) as FetchImpl;

		await streamPiNative(
			fakeModel({ headers: { "x-skc-slot": "worker-1", Authorization: "Bearer model-wins" } }),
			baseContext,
			{ apiKey: "options-loses", fetch: fetchImpl },
		).result();

		const headers = captured.init?.headers as Record<string, string>;
		expect(headers["x-skc-slot"]).toBe("worker-1");
		expect(headers.Authorization).toBe("Bearer model-wins");
	});

	it("throws synchronously when `baseUrl` is missing", async () => {
		const broken = fakeModel({ baseUrl: "" as unknown as string });
		// The promise the iterator awaits surfaces the error via `.result()`.
		const stream = streamPiNative(broken, baseContext, { apiKey: "k" });
		await expect(stream.result()).rejects.toThrow(/baseUrl/);
	});
});

describe("streamPiNative event flow", () => {
	it("pushes parsed events verbatim and resolves `.result()` on terminal `done`", async () => {
		const final = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: {
				input: 4,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const partial = baseAssistant({ content: [{ type: "text", text: "hi" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial },
			{ type: "done", reason: "stop", message: final },
		];
		const fetchImpl: FetchImpl = (async () => fakeResponse(events)) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		const seen = await collectEvents(stream);
		const result = await stream.result();

		expect(seen).toEqual(events);
		expect(result).toEqual(final);
	});

	it("classifies non-2xx responses into Errors with status + type tags", async () => {
		const fetchImpl: FetchImpl = (async () =>
			new Response(JSON.stringify({ error: { type: "authentication_error", message: "no credential" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			})) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/no credential/);
	});

	it("falls back to plain text on a non-JSON error body", async () => {
		const fetchImpl: FetchImpl = (async () => new Response("bad gateway", { status: 502 })) as FetchImpl;
		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(stream.result()).rejects.toThrow(/502/);
	});

	it("fails with classified transport evidence when the SSE stream closes silently", async () => {
		const halfEvents: AssistantMessageEvent[] = [{ type: "start", partial: baseAssistant() }];
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of halfEvents) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				controller.close();
			},
		});
		const fetchImpl: FetchImpl = (async () =>
			new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as FetchImpl;

		const stream = streamPiNative(fakeModel(), baseContext, { apiKey: "k", fetch: fetchImpl });
		await expect(collectEvents(stream)).rejects.toMatchObject({
			message: "pi-native SSE stream closed without terminal event",
			status: 502,
		});
		await expect(stream.result()).rejects.toMatchObject({ status: 502 });
	});

	it("fails fast when already aborted without sending a request", async () => {
		const fetchSpy = spyOn({ fetch: globalThis.fetch }, "fetch");
		const controller = new AbortController();
		controller.abort(new Error("pre-aborted"));
		const result = await streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchSpy,
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("pre-aborted");
		expect(fetchSpy.mock.calls).toHaveLength(0);
	});

	it("propagates caller abort while waiting for headers even when fetch does not settle", async () => {
		const captured: { signal?: AbortSignal } = {};
		const pending = Promise.withResolvers<Response>();
		const fetchImpl: FetchImpl = (_input, init) => {
			captured.signal = init?.signal ?? undefined;
			return pending.promise;
		};
		const controller = new AbortController();
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			fetch: fetchImpl,
			signal: controller.signal,
		});
		const reason = new Error("user cancel");
		controller.abort(reason);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("user cancel");
		expect(captured.signal?.aborted).toBe(true);
		expect(captured.signal?.reason).toBe(reason);
	});

	it("removes the caller abort listener and cancels trailing reads after a terminal event", async () => {
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		const terminal = baseAssistant();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(source) {
				source.enqueue(sseBytes([{ type: "done", reason: "stop", message: terminal }]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			signal: controller.signal,
			fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
		});
		expect((await stream.result()).stopReason).toBe("stop");
		await Bun.sleep(0);
		expect(cancelled).toBe(true);
		expect(remove.mock.calls.some(call => call[0] === "abort")).toBe(true);
	});

	it("times out a pre-header stall without waiting for fetch to cooperate", async () => {
		const pending = Promise.withResolvers<Response>();
		const captured: { signal?: AbortSignal } = {};
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			streamFirstEventTimeoutMs: 20,
			fetch: (_input, init) => {
				captured.signal = init?.signal ?? undefined;
				return pending.promise;
			},
		});
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Pi-native stream timed out while waiting for the first event");
		expect(captured.signal?.aborted).toBe(true);
	});

	it("does not extend a semantic first deadline with repeated metadata", async () => {
		let stopHeartbeats = () => {};
		const bytes = new TextEncoder().encode(
			`data: ${JSON.stringify({ type: "start", partial: baseAssistant() })}\n\n`,
		);
		const body = new ReadableStream<Uint8Array>({
			start(source) {
				const timer = setInterval(() => source.enqueue(bytes), 2);
				stopHeartbeats = () => clearInterval(timer);
			},
			cancel() {
				stopHeartbeats();
			},
		});
		try {
			const result = await streamPiNative(fakeModel(), baseContext, {
				apiKey: "k",
				streamFirstEventTimeoutMs: 20,
				streamIdleTimeoutMs: 30,
				fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
			}).result();
			expect(result.errorMessage).toBe("Pi-native stream timed out while waiting for the first event");
		} finally {
			stopHeartbeats();
		}
	});

	it("preserves a streamed prefix when the semantic idle deadline expires", async () => {
		const captured: { signal?: AbortSignal } = {};
		const prefix = baseAssistant({ content: [{ type: "text", text: "preserved prefix" }] });
		const body = new ReadableStream<Uint8Array>({
			start(source) {
				const events: AssistantMessageEvent[] = [
					{ type: "start", partial: prefix },
					{ type: "text_delta", contentIndex: 0, delta: "preserved prefix", partial: prefix },
				];
				source.enqueue(
					new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")),
				);
			},
		});
		const stream = streamPiNative(fakeModel(), baseContext, {
			apiKey: "k",
			streamFirstEventTimeoutMs: 100,
			streamIdleTimeoutMs: 20,
			fetch: async (_input, init) => {
				captured.signal = init?.signal ?? undefined;
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Pi-native stream stalled while waiting for the next event");
		expect(result.content).toEqual(prefix.content);
		expect(captured.signal?.aborted).toBe(true);
	});
});
