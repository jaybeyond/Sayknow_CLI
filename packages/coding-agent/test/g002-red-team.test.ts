import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool, type StreamFn, ThinkingLevel } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model, streamSimple } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { convertToLlm } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";
import * as z from "zod/v4";

/**
 * G002 red-team: every case runs the production AgentSession + real `streamSimple`
 * serializers/SDKs, replacing only `globalThis.fetch`. Each fetch call is one
 * concrete upstream request.
 */

type Reply = () => Response;
type SettingsValues = Parameters<typeof Settings.isolated>[0];

interface WireLog {
	urls: string[];
	bodies: string[];
	times: number[];
}

const CONTINUATION_MARKER = "Continue directly from where it stops";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return String(input);
}

function installFetch(next: (index: number) => Response): WireLog {
	const log: WireLog = { urls: [], bodies: [], times: [] };
	const t0 = performance.now();
	vi.spyOn(globalThis, "fetch").mockImplementation((async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => {
		log.urls.push(requestUrl(input));
		log.times.push(Math.round(performance.now() - t0));
		log.bodies.push(typeof init?.body === "string" ? init.body : "");
		return next(log.urls.length - 1);
	}) as typeof fetch);
	return log;
}

function installReplies(replies: readonly Reply[]): WireLog {
	return installFetch(index => {
		const reply = replies[index];
		if (!reply) throw new Error(`Unexpected outbound request #${index + 1}`);
		return reply();
	});
}

function status(code: number, api: string, headers: Record<string, string> = {}): Response {
	const body =
		api === "anthropic-messages"
			? { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
			: { error: { message: "Service temporarily unavailable", type: "server_error", code: null } };
	return new Response(JSON.stringify(body), {
		status: code,
		headers: { "content-type": "application/json", ...headers },
	});
}

function sse(frames: readonly string[], end: "close" | "disconnect"): Reply {
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
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
}

// ---- openai-completions frames
function oc(model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-g002",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}
const OC_DONE = "data: [DONE]\n\n";

// ---- anthropic frames
function af(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function aStart(model: string): string {
	return af("message_start", {
		type: "message_start",
		message: {
			id: "msg_g002",
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	});
}

function textOf(message: AssistantMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** Races idle against a wall-clock bound so a hang is observable instead of a runner timeout. */
async function settle(session: AgentSession, run: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const idle = await Promise.race([
		run.then(() => session.waitForIdle()).then(() => true),
		new Promise<boolean>(resolve => {
			timer = setTimeout(() => resolve(false), ms);
		}),
	]);
	clearTimeout(timer);
	return idle;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("G002 red-team over real provider serializers + fetch stub", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@g002-red-team-");
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

	function model(found: Model | undefined, api: string): Model {
		if (!found) throw new Error("missing bundled model");
		expect(found.api).toBe(api);
		return found;
	}

	const groq = () => model(getBundledModel("groq", "llama-3.3-70b-versatile"), "openai-completions");
	const anthropic = () => model(getBundledModel("anthropic", "claude-sonnet-4-5"), "anthropic-messages");
	const openaiResponses = () => model(getBundledModel("openai", "gpt-4o-mini"), "openai-responses");

	function build(options: {
		model: Model;
		settings?: SettingsValues;
		tools?: AgentTool[];
		streamFn?: StreamFn;
		sessionManager?: SessionManager;
		thinkingOff?: boolean;
	}): AgentSession {
		const m = options.model;
		authStorage.setRuntimeApiKey(m.provider, `${m.provider}-test-key`);
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: m, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: options.streamFn ?? streamSimple,
			convertToLlm,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, ...options.settings });
		settings.setModelRole("default", `${m.provider}/${m.id}${options.thinkingOff ? ":off" : ""}`);
		const built = new AgentSession({
			agent,
			sessionManager: options.sessionManager ?? SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		if (options.thinkingOff) built.setThinkingLevel(ThinkingLevel.Off);
		built.subscribe(() => {});
		return built;
	}

	function assistants(s: AgentSession): AssistantMessage[] {
		return s.agent.state.messages.filter((message): message is AssistantMessage => message.role === "assistant");
	}

	function counted(): { tool: AgentTool; runs: () => number } {
		let runs = 0;
		return {
			runs: () => runs,
			tool: {
				name: "counted",
				label: "Counted",
				description: "Counts real executions",
				parameters: z.object({ path: z.string().optional() }),
				execute: async () => {
					runs++;
					return { content: [{ type: "text" as const, text: "counted result" }] };
				},
			},
		};
	}

	// ---------------------------------------------------------------- 1) wire cap
	describe("1) persistent transient: per-step real fetch count <= 7", () => {
		const cases: Array<[string, () => Model, SettingsValues]> = [
			["openai-completions / fallback.auto=false", groq, { "fallback.auto": false }],
			["openai-completions / fallback.auto default", groq, {}],
			["anthropic-messages / fallback.auto=false", anthropic, { "fallback.auto": false }],
			["anthropic-messages / fallback.auto default", anthropic, {}],
			["openai-responses / fallback.auto=false", openaiResponses, { "fallback.auto": false }],
			["openai-responses / fallback.auto default", openaiResponses, {}],
		];
		for (const [label, pick, settings] of cases) {
			it(label, async () => {
				const m = pick();
				// retry-after-ms keeps hidden SDK backoff short; it does not lower any cap.
				const log = installFetch(() => status(503, m.api, { "retry-after-ms": "1" }));
				vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
				session = build({ model: m, settings });
				const run = session.prompt("persistent outage").catch(() => undefined);
				const idle = await settle(session, run, 12_000);
				expect(log.urls.length).toBeGreaterThanOrEqual(1);
				expect(log.urls.length).toBeLessThanOrEqual(7);
				expect(idle).toBe(true);
				expect(assistants(session).at(-1)?.stopReason).toBe("error");
				expect(session.isRetrying).toBe(false);
			});
		}

		it("explicit retry.maxRetries=99 still stays within 7 real requests (openai-completions)", async () => {
			const m = groq();
			const log = installFetch(() => status(503, m.api, { "retry-after-ms": "1" }));
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			session = build({ model: m, settings: { "fallback.auto": false, "retry.maxRetries": 99 } });
			await session.prompt("explicit large cap");
			await session.waitForIdle();
			expect(log.urls.length).toBeLessThanOrEqual(7);
		});
	});

	// ---------------------------------------------------------------- 2) abort after 503
	it("2) abort right after a 503 sends zero additional requests", async () => {
		const m = groq();
		let s: AgentSession | undefined;
		const log = installFetch(() => {
			// Abort as soon as the 503 is on its way back, before any SDK/session resend.
			queueMicrotask(() => {
				void s?.abort();
			});
			return status(503, m.api, { "retry-after-ms": "300" });
		});
		session = build({ model: m, settings: { "fallback.auto": false, "retry.maxRetries": 3 } });
		s = session;
		await session.prompt("abort me");
		await session.waitForIdle();
		await Bun.sleep(800);
		expect(log.urls).toHaveLength(1);
	});

	it("2b) abortRetry during session backoff after a 503 sends zero additional requests", async () => {
		const m = groq();
		// x-should-retry:false disables the hidden SDK resend so only session backoff remains.
		const log = installFetch(() => status(503, m.api, { "x-should-retry": "false" }));
		session = build({
			model: m,
			settings: {
				"fallback.auto": false,
				"retry.maxRetries": 3,
				"retry.baseDelayMs": 600_000,
				"retry.maxDelayMs": 600_000,
			},
		});
		const s = session;
		s.subscribe(event => {
			if (event.type === "auto_retry_start") queueMicrotask(() => s.abortRetry());
		});
		await session.prompt("abort retry");
		await session.waitForIdle();
		await Bun.sleep(200);
		expect(log.urls).toHaveLength(1);
	});

	// ---------------------------------------------------------------- 3) visible prefix / partial tool
	for (const [label, settings] of [
		["defaults", {}],
		["retry.maxRetries=1", { "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 }],
	] as Array<[string, SettingsValues]>) {
		it(`3a) public text prefix then disconnect: shown once, never deleted (${label})`, async () => {
			const m = groq();
			const prefix = "Three findings: one,";
			const log = installFetch(index =>
				index === 0
					? sse([oc(m.id, { role: "assistant" }), oc(m.id, { content: prefix })], "disconnect")()
					: sse(
							[oc(m.id, { role: "assistant" }), oc(m.id, { content: " two." }), oc(m.id, {}, "stop"), OC_DONE],
							"close",
						)(),
			);
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			session = build({ model: m, settings: { "fallback.auto": false, ...settings } });
			const deltas: string[] = [];
			session.subscribe(event => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
					deltas.push(event.assistantMessageEvent.delta);
			});
			await session.prompt("report");
			await session.waitForIdle();
			expect(occurrences(deltas.join(""), prefix)).toBe(1);
			const transcript = assistants(session).map(textOf).join("");
			expect(occurrences(transcript, prefix)).toBe(1);
			expect(assistants(session)[0]?.content).toEqual([{ type: "text", text: prefix }]);
			expect(log.urls.length).toBeLessThanOrEqual(2);
			for (const body of log.bodies.slice(1)) expect(occurrences(body, prefix)).toBe(1);
		});
	}

	it("3b) partial toolCall then disconnect: zero automatic requests and zero tool executions", async () => {
		const m = groq();
		const { tool, runs } = counted();
		const log = installFetch(() =>
			sse(
				[
					oc(m.id, { role: "assistant" }),
					oc(m.id, { content: "Writing now." }),
					oc(m.id, {
						tool_calls: [
							{ index: 0, id: "c1", type: "function", function: { name: "counted", arguments: '{"pa' } },
						],
					}),
				],
				"disconnect",
			)(),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			tools: [tool],
			settings: { "fallback.auto": false, "retry.maxRetries": 3, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
		});
		await session.prompt("write it");
		await session.waitForIdle();
		expect(log.urls).toHaveLength(1);
		expect(runs()).toBe(0);
		expect(textOf(assistants(session)[0]!)).toContain("Writing now.");
	});

	// ---------------------------------------------------------------- 4) completed tool
	it("4) disconnect after a completed tool (no text) never re-runs the tool; repeated call id executes 0", async () => {
		const m = groq();
		const { tool, runs } = counted();
		const toolCallReply = sse(
			[
				oc(m.id, { role: "assistant" }),
				oc(m.id, {
					tool_calls: [{ index: 0, id: "c7", type: "function", function: { name: "counted", arguments: "{}" } }],
				}),
				oc(m.id, {}, "tool_calls"),
				OC_DONE,
			],
			"close",
		);
		const log = installReplies([
			toolCallReply,
			// Next step drops before any visible text.
			sse([oc(m.id, { role: "assistant" })], "disconnect"),
			// Retry: the model re-issues the same completed call id.
			toolCallReply,
			sse([oc(m.id, { role: "assistant" }), oc(m.id, { content: "done" }), oc(m.id, {}, "stop"), OC_DONE], "close"),
			sse([oc(m.id, { role: "assistant" }), oc(m.id, { content: "done" }), oc(m.id, {}, "stop"), OC_DONE], "close"),
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			tools: [tool],
			settings: { "fallback.auto": false, "retry.maxRetries": 2, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
		});
		await session.prompt("inspect");
		await session.waitForIdle();
		expect(runs()).toBe(1);
		expect(log.urls.length).toBeLessThanOrEqual(5);
		expect(
			session.agent.state.messages.filter(message => message.role === "toolResult" && message.toolCallId === "c7"),
		).toHaveLength(1);
	});

	// ---------------------------------------------------------------- 5) signed thinking
	it("5) signed thinking + public text then disconnect: no continuation request", async () => {
		const m = anthropic();
		const log = installFetch(() =>
			sse(
				[
					aStart(m.id),
					af("content_block_start", {
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "" },
					}),
					af("content_block_delta", {
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "private plan" },
					}),
					af("content_block_delta", {
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "immutable-signature" },
					}),
					af("content_block_stop", { type: "content_block_stop", index: 0 }),
					af("content_block_start", {
						type: "content_block_start",
						index: 1,
						content_block: { type: "text", text: "" },
					}),
					af("content_block_delta", {
						type: "content_block_delta",
						index: 1,
						delta: { type: "text_delta", text: "Visible prefix" },
					}),
				],
				"disconnect",
			)(),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			settings: { "fallback.auto": false, "retry.maxRetries": 3, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
		});
		await session.prompt("think then answer");
		await session.waitForIdle();
		expect(log.urls).toHaveLength(1);
		for (const body of log.bodies) expect(body).not.toContain(CONTINUATION_MARKER);
		expect(textOf(assistants(session)[0]!)).toBe("Visible prefix");
	});

	// ---------------------------------------------------------------- 6) uncertain upstream
	it("6) onUncertainUpstream before a real 503: zero automatic resend, /retry false, new prompt works", async () => {
		const m = groq();
		let uncertainOnce = true;
		const log = installFetch(index =>
			index === 0
				? status(503, m.api, { "retry-after-ms": "1" })
				: sse(
						[oc(m.id, { role: "assistant" }), oc(m.id, { content: "fresh" }), oc(m.id, {}, "stop"), OC_DONE],
						"close",
					)(),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		session = build({
			model: m,
			settings: { "fallback.auto": false, "retry.maxRetries": 3, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
			streamFn: (requested, context, options) => {
				if (uncertainOnce) {
					uncertainOnce = false;
					options?.onUncertainUpstream?.("Gateway dispatch has unobserved remote requests and effects");
				}
				return streamSimple(requested, context, options);
			},
		});
		await session.prompt("dispatch remotely");
		await session.waitForIdle();
		expect(log.urls).toHaveLength(1);
		expect(assistants(session).at(-1)?.stopReason).toBe("error");
		await expect(session.retry()).resolves.toBe(false);
		expect(log.urls).toHaveLength(1);
		await session.prompt("start over");
		await session.waitForIdle();
		expect(log.urls).toHaveLength(2);
		expect(assistants(session).at(-1)?.stopReason).toBe("stop");
	});

	// ---------------------------------------------------------------- 7) in_flight hydrate
	it("7) reopening a session with an in_flight checkpoint sends nothing; new prompt runs a full tool loop", async () => {
		const m = groq();
		const dir = tempDir.path();
		const first = SessionManager.create(dir, dir);
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "interrupted" }],
			timestamp: Date.now(),
		};
		first.appendMessage(user);
		first.appendCustomEntry("recovery_checkpoint", { version: 1, state: "in_flight", stepId: "lost-step" });
		await first.ensureOnDisk();
		await first.flush();
		const file = first.getSessionFile();
		if (!file) throw new Error("expected persisted session file");

		const { tool, runs } = counted();
		const log = installReplies([
			sse(
				[
					oc(m.id, { role: "assistant" }),
					oc(m.id, {
						tool_calls: [
							{ index: 0, id: "t1", type: "function", function: { name: "counted", arguments: "{}" } },
						],
					}),
					oc(m.id, {}, "tool_calls"),
					OC_DONE,
				],
				"close",
			),
			sse(
				[oc(m.id, { role: "assistant" }), oc(m.id, { content: "finished" }), oc(m.id, {}, "stop"), OC_DONE],
				"close",
			),
		]);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const reopened = await SessionManager.open(file);
		session = build({
			model: m,
			tools: [tool],
			sessionManager: reopened,
			settings: { "fallback.auto": false, "retry.maxRetries": 3, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
		});
		const context = reopened.buildSessionContext();
		session.agent.replaceMessages(context.messages);
		await Bun.sleep(100);
		await session.waitForIdle();
		expect(log.urls).toHaveLength(0);
		// Manual retry of the interrupted user tail must stay fail-closed too.
		await session.retry().catch(() => false);
		await session.waitForIdle();
		expect(log.urls).toHaveLength(0);

		await session.prompt("explicit new request");
		await session.waitForIdle();
		expect(log.urls).toHaveLength(2);
		expect(runs()).toBe(1);
		expect(assistants(session).at(-1)?.stopReason).toBe("stop");
	});

	// ---------------------------------------------------------------- 8) flush failure
	it("8) in_flight checkpoint flush failure sends zero requests", async () => {
		const m = groq();
		const log = installFetch(() =>
			sse([oc(m.id, { role: "assistant" }), oc(m.id, { content: "x" }), oc(m.id, {}, "stop"), OC_DONE], "close")(),
		);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const dir = tempDir.path();
		session = build({
			model: m,
			sessionManager: SessionManager.create(dir, dir),
			settings: { "fallback.auto": false, "retry.maxRetries": 3, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10 },
		});
		vi.spyOn(session.sessionManager, "flush").mockRejectedValue(new Error("disk failure"));
		await session.prompt("must not send").catch(() => undefined);
		await session.waitForIdle();
		expect(log.urls).toHaveLength(0);
	});

	// ---------------------------------------------------------------- 9) huge Retry-After
	for (const [label, pick, code] of [
		["openai-completions 503", groq, 503],
		["openai-completions 429", groq, 429],
		["anthropic-messages 529", anthropic, 529],
		["anthropic-messages 429", anthropic, 429],
		["openai-responses 503", openaiResponses, 503],
	] as Array<[string, () => Model, number]>) {
		it(`9) Retry-After: 3600 is not retried (${label})`, async () => {
			const m = pick();
			const log = installFetch(() => status(code, m.api, { "retry-after": "3600" }));
			const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			session = build({ model: m, settings: { "fallback.auto": false } });
			const run = session.prompt("huge retry-after").catch(() => undefined);
			const idle = await settle(session, run, 12_000);
			expect(log.urls).toHaveLength(1);
			expect(idle).toBe(true);
			expect(wait).not.toHaveBeenCalled();
		});
	}
});
