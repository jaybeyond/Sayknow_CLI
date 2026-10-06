/**
 * Client half of the pi-native auth-gateway protocol.
 *
 * Dispatches a {@link streamSimple}-shaped request to an `skc auth-gateway`
 * via `POST /v1/pi/stream`, reads the SSE event stream back, and pushes the
 * parsed events into a local {@link AssistantMessageEventStream} — the same
 * stream type every other provider client produces. Callers downstream of
 * `streamSimple` cannot tell whether the events came from a real provider
 * SDK or from a gateway hop; they consume `AssistantMessageEvent`s either
 * way.
 *
 * Activated when a {@link Model} has `transport: "pi-native"` set; the
 * dispatch hook lives in `streamSimple()` (see `../stream.ts`). Used by
 * containerized SKC deployments that route every LLM call through a
 * credential-holding sidecar so the container stays credential-free.
 */
import { readSseJson, structuredCloneJSON } from "@sayknow-cli/utils";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	getProviderFirstEventTimeoutFallbackMs,
	getProviderStreamIdleTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	isSemanticContentDelta,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { RecoveryAdmissionError } from "../utils/recovery-budget";

/**
 * Fields that must not cross the wire — either non-serializable (functions,
 * `AbortSignal`, the provider-session `Map`) or server-controlled
 * (`apiKey`, which the gateway injects from its own credential store; the
 * client's `apiKey` is the gateway *bearer*, sent in the `Authorization`
 * header rather than the request body).
 */
const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"credentialFetch",
	"onUncertainUpstream",
	"onUpstreamRequest",
	"onPayload",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
	"fallbackAttempt",
]);

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(options)) {
		if (v === undefined) continue;
		if (NON_WIRE_KEYS.has(k as keyof SimpleStreamOptions)) continue;
		wire[k] = v;
	}
	return wire;
}

async function decodeGatewayError(response: Response): Promise<Error> {
	const status = response.status;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = await response.text().catch(() => "");
	}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error: unknown }).error;
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			const type = (err as { type?: unknown }).type;
			const code = (err as { code?: unknown }).code;
			const out = new Error(typeof message === "string" ? message : `auth-gateway ${status}`);
			const transportError = out as Error & {
				status?: number;
				type?: string;
				providerCode?: string;
				headers?: Headers;
			};
			transportError.status = status;
			transportError.headers = response.headers;
			if (typeof type === "string") transportError.type = type;
			if (typeof code === "string") transportError.providerCode = code;
			else if (typeof type === "string") transportError.providerCode = type;
			return out;
		}
	}
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const err = new Error(`auth-gateway ${status}: ${text || response.statusText}`);
	const transportError = err as Error & { status?: number; headers?: Headers };
	transportError.status = status;
	transportError.headers = response.headers;
	return err;
}

/**
 * Resolve the `/v1/pi/stream` endpoint URL from the model's `baseUrl`.
 * Trims a trailing slash so concatenation can't double-slash; throws when
 * the baseUrl is missing (transport=pi-native without a gateway target is
 * a configuration error, not a runtime recoverable one).
 */
function resolveStreamUrl(model: Model<Api>): string {
	if (!model.baseUrl) {
		throw new Error(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return `${model.baseUrl.replace(/\/+$/, "")}/v1/pi/stream`;
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(model.headers ?? {}),
	};
	if (apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

/**
 * Stream a turn through an `skc auth-gateway` over the pi-native protocol.
 *
 * The returned {@link AssistantMessageEventStream} receives each parsed
 * `AssistantMessageEvent` verbatim from the gateway; the terminal `done` /
 * `error` event resolves `.result()` automatically via the base class's
 * completion check. Non-streaming consumers just call `.result()` and pay
 * for SSE framing they don't use — that overhead is dominated by provider
 * latency, so we always stream rather than maintaining a parallel
 * non-streaming path.
 */
export function streamPiNative<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStreamType {
	const producer = new AssistantMessageEventStream();
	const stream = new AssistantMessageEventStream();
	const signal = options?.signal;
	const requestAbort = new AbortController();
	const startedAt = Date.now();
	const idleTimeoutMs =
		options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs(model.provider));
	// An explicitly disabled first-event watchdog stays disabled (0); undefined would
	// otherwise fall back to the idle window inside the iterator.
	const firstTimeoutMs =
		options?.streamFirstEventTimeoutMs ??
		getStreamFirstEventTimeoutMs(idleTimeoutMs, getProviderFirstEventTimeoutFallbackMs(model.provider)) ??
		0;
	const idleError = "Pi-native stream stalled while waiting for the next event";
	const firstError = "Pi-native stream timed out while waiting for the first event";
	const forwardAbort = (): void => requestAbort.abort(signal?.reason);
	if (signal?.aborted) forwardAbort();
	else signal?.addEventListener("abort", forwardAbort, { once: true });
	let partial = makeSyntheticAssistant(model as Model<Api>);
	let finished = false;

	// One semantic watchdog covers headers, first content, and every subsequent
	// content gap. Metadata and gateway heartbeats never buy a new deadline.
	void (async () => {
		try {
			for await (const event of iterateWithIdleTimeout(producer, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstTimeoutMs,
				firstItemStartedAt: startedAt,
				strictDeadline: true,
				errorMessage: idleError,
				firstItemErrorMessage: firstError,
				abortSignal: signal,
				onIdle: () => requestAbort.abort(new Error(idleError)),
				onFirstItemTimeout: () => requestAbort.abort(new Error(firstError)),
				isProgressItem: isSemanticContentDelta,
			})) {
				stream.push(event);
				if (event.type === "done" || event.type === "error") break;
			}
			stream.end();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (signal?.aborted || message === idleError || message === firstError || partial.content.length > 0) {
				const failure = structuredCloneJSON(partial);
				failure.stopReason = signal?.aborted ? "aborted" : "error";
				failure.errorMessage = message;
				stream.push({ type: "error", reason: failure.stopReason, error: failure });
				stream.end();
			} else {
				stream.fail(error);
			}
		} finally {
			finished = true;
			if (!requestAbort.signal.aborted) requestAbort.abort(new Error("Pi-native stream finished"));
			signal?.removeEventListener("abort", forwardAbort);
		}
	})();

	void (async () => {
		try {
			requestAbort.signal.throwIfAborted();
			const url = resolveStreamUrl(model as Model<Api>);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(model as Model<Api>, options?.apiKey);
			const body = JSON.stringify({ modelId: model.id, context, options: buildWireOptions(options), stream: true });
			// The gateway runs the provider request (and any hidden resend) remotely; its
			// effects are unobservable here, so automatic recovery must not resend. The
			// admitted fetch has already validated and charged the wire before this fires.
			const markDispatched = (): void =>
				options?.onUncertainUpstream?.("Pi-native gateway dispatch has unobserved remote requests and effects");
			const response = await fetchImpl(url, { method: "POST", headers, body, signal: requestAbort.signal }).then(
				result => {
					markDispatched();
					return result;
				},
				(error: unknown) => {
					// A refused admission sent nothing; any other rejection may have reached the gateway.
					if (!(error instanceof RecoveryAdmissionError)) markDispatched();
					throw error;
				},
			);
			if (finished) {
				void response.body?.cancel();
				return;
			}
			if (!response.ok) throw await decodeGatewayError(response);
			if (!response.body) throw new Error("auth-gateway returned empty body");
			for await (const event of readSseJson<AssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				requestAbort.signal,
			)) {
				if (finished) return;
				if ("partial" in event) partial = structuredCloneJSON(event.partial);
				producer.push(event);
				if (event.type === "done" || event.type === "error") {
					producer.end();
					return;
				}
			}
			if (!finished)
				throw Object.assign(new Error("pi-native SSE stream closed without terminal event"), { status: 502 });
		} catch (error) {
			if (!finished) producer.fail(error);
		}
	})();

	return stream;
}

function makeSyntheticAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
