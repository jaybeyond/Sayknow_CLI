import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getBundledModel, type Model } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { createAgentSession } from "@sayknow-cli/coding-agent/sdk";
import type { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { getProjectDir, setProjectDir, TempDir } from "@sayknow-cli/utils";

type CacheControl = { type: string; ttl?: string };
type WireBody = { model?: string; cache_control?: CacheControl };

/** First-party Anthropic request bodies are gzip-compressed on the wire. */
function wireBodyText(init?: Parameters<typeof fetch>[1]): string {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (!(body instanceof Uint8Array)) return "";
	const gzip = new Headers(init?.headers).get("content-encoding") === "gzip";
	return new TextDecoder().decode(gzip ? gunzipSync(body) : body);
}

function anthropicTextReply(model: string): Response {
	const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events: Array<{ type: string } & Record<string, unknown>> = [
		{
			type: "message_start",
			message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("task.cacheRetention", () => {
	const originalProjectDir = getProjectDir();
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@subagent-cache-retention-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	function anthropicModel(): Model {
		const found = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!found) throw new Error("missing bundled model");
		return found;
	}

	/** Runs one prompt through a production SDK session and returns the inference request it sent. */
	async function inferenceRequest(options: {
		taskDepth: number;
		settings: Record<string, unknown>;
	}): Promise<WireBody> {
		const model = anthropicModel();
		const bodies: WireBody[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!new URL(url).pathname.endsWith("/v1/messages")) return new Response("{}", { status: 404 });
			bodies.push(JSON.parse(wireBodyText(init)) as WireBody);
			return anthropicTextReply(model.id);
		}) as typeof fetch);

		authStorage.setRuntimeApiKey(model.provider, "sk-ant-api-test");
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "fallback.auto": false, ...options.settings }),
			model,
			taskDepth: options.taskDepth,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});
		session = created.session;
		await session.prompt("hello");
		await session.waitForIdle();

		const request = bodies.find(body => body.model === model.id);
		if (!request) throw new Error("no inference request reached the wire");
		return request;
	}

	it("sends the short TTL for a subagent session set to short", async () => {
		const request = await inferenceRequest({ taskDepth: 1, settings: { "task.cacheRetention": "short" } });
		expect(request.cache_control).toEqual({ type: "ephemeral" });
	});

	it("leaves the main session on the long TTL when subagents are set to short", async () => {
		const request = await inferenceRequest({ taskDepth: 0, settings: { "task.cacheRetention": "short" } });
		expect(request.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("keeps a subagent session on the long TTL by default", async () => {
		const request = await inferenceRequest({ taskDepth: 1, settings: {} });
		expect(request.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("sends no cache marker for a subagent session set to none", async () => {
		const request = await inferenceRequest({ taskDepth: 1, settings: { "task.cacheRetention": "none" } });
		expect(JSON.stringify(request)).not.toContain("cache_control");
	});
});
