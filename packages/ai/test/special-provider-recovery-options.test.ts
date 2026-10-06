import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createProviderErrorMessage } from "../src/providers/error-message";
import { clearGitLabDuoDirectAccessCache, getGitLabDuoModels, streamGitLabDuo } from "../src/providers/gitlab-duo";
import * as registerBuiltins from "../src/providers/register-builtins";
import { streamSimple } from "../src/stream";
import type { Api, Context, FetchImpl, Model, StreamOptions } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import { beginAttempt } from "../src/utils/fallback-transport";
import * as kimiOauth from "../src/utils/oauth/kimi";
import { createUpstreamAdmission, type RecoveryRequestKind } from "../src/utils/recovery-budget";

/**
 * Kimi/Synthetic/GitLab Duo wrap a built-in provider. The session's recovery
 * ownership (managed attempt, local retry cap, upstream admission) must reach
 * that inner stream unchanged, or the wrapped SDK replays requests the shared
 * same-model budget never admitted.
 */

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function syntheticModel(): Model<"openai-completions"> {
	return {
		id: "hf:test/model",
		name: "Synthetic test",
		api: "openai-completions",
		provider: "synthetic",
		baseUrl: "https://api.synthetic.new/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function kimiModel(): Model<"openai-completions"> {
	return {
		id: "kimi-for-coding",
		name: "Kimi test",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

const kimiHeadersStub = {
	"User-Agent": "KimiCLI/0.0.0",
	"X-Msh-Platform": "kimi_cli",
	"X-Msh-Version": "0.0.0",
	"X-Msh-Device-Name": "test",
	"X-Msh-Device-Model": "test",
	"X-Msh-Os-Version": "test",
	"X-Msh-Device-Id": "test",
} as const;

const GITLAB_DIRECT_ACCESS_URL = "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";
const GITLAB_ANTHROPIC_PROXY_URL = "https://cloud.gitlab.com/ai/v1/proxy/anthropic/";

function gitlabDuoAnthropicModel(): Model<Api> {
	const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-haiku-4-5");
	if (!model) throw new Error("GitLab Duo test model missing");
	return model;
}

function requestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : String(input);
}

/** Direct-access token succeeds; every other (inference) request fails with 503. */
function gitlabFetch(urls: string[]) {
	return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
		const url = requestUrl(input);
		urls.push(url);
		if (url === GITLAB_DIRECT_ACCESS_URL) {
			return new Response(JSON.stringify({ token: "duo-direct-token", headers: { "x-gitlab-test": "1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	};
}

function failingFetch(calls: { count: number }) {
	return async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
		calls.count++;
		return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("special provider recovery ownership", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards the managed attempt through the Synthetic shim so the SDK sends exactly one request", async () => {
		const calls = { count: 0 };
		const result = await streamSimple(syntheticModel(), context, {
			apiKey: "test-key",
			fetch: failingFetch(calls),
			fallbackManaged: true,
			fallbackAttempt: beginAttempt("synthetic/hf:test/model", 1),
			streamFirstEventTimeoutMs: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls.count).toBe(1);
	});

	it("forwards an explicit local retry cap through the Synthetic shim", async () => {
		const calls = { count: 0 };
		const result = await streamSimple(syntheticModel(), context, {
			apiKey: "test-key",
			fetch: failingFetch(calls),
			requestMaxRetries: 0,
			streamFirstEventTimeoutMs: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls.count).toBe(1);
	});

	it("forwards the managed attempt through the Kimi anthropic-format shim so the SDK sends exactly one request", async () => {
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);
		const urls: string[] = [];
		const calls = { count: 0 };
		const fetch503 = failingFetch(calls);
		const result = await streamSimple(kimiModel(), context, {
			apiKey: "test-key",
			fetch: (input, init) => {
				urls.push(requestUrl(input));
				return fetch503(input, init);
			},
			fallbackManaged: true,
			fallbackAttempt: beginAttempt("kimi-code/kimi-for-coding", 1),
			streamFirstEventTimeoutMs: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(calls.count).toBe(1);
		expect(urls[0]?.startsWith("https://api.kimi.com/coding/v1/messages")).toBe(true);
	});
});

describe("GitLab Duo recovery ownership", () => {
	beforeEach(() => {
		clearGitLabDuoDirectAccessCache();
	});

	afterEach(() => {
		clearGitLabDuoDirectAccessCache();
		vi.restoreAllMocks();
	});

	it("admits the direct access token request through credentialFetch, not the inference fetch", async () => {
		const kinds: RecoveryRequestKind[] = [];
		const urls: string[] = [];
		const admission = createUpstreamAdmission(kind => kinds.push(kind), gitlabFetch(urls));
		const model = gitlabDuoAnthropicModel();

		const result = await streamGitLabDuo(model, context, {
			apiKey: "gitlab-token-credential-fetch",
			fetch: admission.fetch,
			credentialFetch: admission.credentialFetch,
			onUpstreamRequest: admission.onUpstreamRequest,
			fallbackManaged: true,
			fallbackAttempt: beginAttempt(`gitlab-duo/${model.id}`, 1),
			streamFirstEventTimeoutMs: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(kinds).toEqual(["token", "inference"]);
		expect(urls).toHaveLength(2);
		expect(urls[0]).toBe(GITLAB_DIRECT_ACCESS_URL);
		expect(urls[1]?.startsWith(GITLAB_ANTHROPIC_PROXY_URL)).toBe(true);
	});

	it("bounds a stalled direct access token request by the first-event deadline", async () => {
		const model = gitlabDuoAnthropicModel();
		const stalled: FetchImpl = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});

		const result = await streamGitLabDuo(model, context, {
			apiKey: "gitlab-token-stalled",
			credentialFetch: stalled,
			streamFirstEventTimeoutMs: 30,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result.content)).toContain("GitLab Duo direct access token request timed out");
	});

	it("sends no direct access token request when the signal is already aborted", async () => {
		const kinds: RecoveryRequestKind[] = [];
		const urls: string[] = [];
		const admission = createUpstreamAdmission(kind => kinds.push(kind), gitlabFetch(urls));
		const controller = new AbortController();
		controller.abort(new Error("cancelled before send"));

		const result = await streamGitLabDuo(gitlabDuoAnthropicModel(), context, {
			apiKey: "gitlab-token-pre-aborted",
			fetch: admission.fetch,
			credentialFetch: admission.credentialFetch,
			onUpstreamRequest: admission.onUpstreamRequest,
			signal: controller.signal,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(kinds).toEqual([]);
		expect(urls).toEqual([]);
	});

	it("passes the owner's upstream admission hook to the inner provider stream", async () => {
		const urls: string[] = [];
		const onUpstreamRequest = (_kind: RecoveryRequestKind): void => {};
		const innerOptions: StreamOptions[] = [];
		vi.spyOn(registerBuiltins, "streamAnthropic").mockImplementation((innerModel, _context, options) => {
			innerOptions.push(options);
			const inner = new AssistantMessageEventStream();
			inner.push({ type: "error", reason: "error", error: createProviderErrorMessage(innerModel, "stub") });
			inner.end();
			return inner;
		});

		const result = await streamGitLabDuo(gitlabDuoAnthropicModel(), context, {
			apiKey: "gitlab-token-hook",
			credentialFetch: gitlabFetch(urls),
			onUpstreamRequest,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(urls).toEqual([GITLAB_DIRECT_ACCESS_URL]);
		expect(innerOptions).toHaveLength(1);
		expect(innerOptions[0]?.onUpstreamRequest).toBe(onUpstreamRequest);
		expect(innerOptions[0]?.apiKey).toBe("duo-direct-token");
	});
});
