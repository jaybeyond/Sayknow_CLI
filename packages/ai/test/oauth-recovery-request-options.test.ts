import { describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "../src/types";
import { refreshAnthropicToken } from "../src/utils/oauth/anthropic";
import { refreshGitHubCopilotToken } from "../src/utils/oauth/github-copilot";
import { refreshGitLabDuoToken } from "../src/utils/oauth/gitlab-duo";
import { refreshGlmZcodeToken } from "../src/utils/oauth/glm-zcode";
import { refreshOAuthToken } from "../src/utils/oauth/index";
import { refreshKimiToken } from "../src/utils/oauth/kimi";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex";
import type { OAuthCredentials } from "../src/utils/oauth/types";
import { RecoveryAdmissionError } from "../src/utils/recovery-budget";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal 3-part JWT whose payload carries the OpenAI Codex auth claim. */
function fakeCodexJwt(): string {
	const header = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "fake-acct" },
			"https://api.openai.com/profile": { email: "test@example.com" },
		}),
	).toString("base64url");
	return `${header}.${payload}.fakesig`;
}

function anthropicTokenBody(): string {
	return JSON.stringify({ access_token: "at-anth", refresh_token: "rt-anth", expires_in: 3600 });
}
function codexTokenBody(): string {
	return JSON.stringify({ access_token: fakeCodexJwt(), refresh_token: "rt-codex", expires_in: 3600 });
}
function kimiTokenBody(): string {
	return JSON.stringify({ access_token: "at-kimi", refresh_token: "rt-kimi", expires_in: 3600 });
}
function gitlabTokenBody(): string {
	return JSON.stringify({
		access_token: "at-gitlab",
		refresh_token: "rt-gitlab",
		expires_in: 7200,
		created_at: Math.floor(Date.now() / 1000),
	});
}

type FetchStub = { fetch: FetchImpl; calls: string[] };

function makeFetchStub(body: string, status = 200): FetchStub {
	const calls: string[] = [];
	const fn = async (input: string | URL | Request): Promise<Response> => {
		calls.push(String(input instanceof Request ? input.url : input));
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	};
	return { fetch: fn as FetchImpl, calls };
}

const GITLAB_CREDS: OAuthCredentials = { access: "old-at", refresh: "old-rt", expires: 0 };

// ---------------------------------------------------------------------------
// Refresh routes the token POST through options.fetch
// ---------------------------------------------------------------------------

describe("OAuthRefreshOptions.fetch: custom fetch used for token POST", () => {
	it("refreshAnthropicToken calls options.fetch exactly once against the token endpoint", async () => {
		const stub = makeFetchStub(anthropicTokenBody());
		const creds = await refreshAnthropicToken("rt", { fetch: stub.fetch });
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toContain("anthropic.com");
		expect(creds.access).toBe("at-anth");
		expect(creds.refresh).toBe("rt-anth");
	});

	it("refreshOpenAICodexToken calls options.fetch exactly once against the token endpoint", async () => {
		const stub = makeFetchStub(codexTokenBody());
		const creds = await refreshOpenAICodexToken("rt", { fetch: stub.fetch });
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toContain("openai.com");
		expect(creds.refresh).toBe("rt-codex");
	});

	it("refreshKimiToken calls options.fetch exactly once against the token endpoint", async () => {
		const stub = makeFetchStub(kimiTokenBody());
		const creds = await refreshKimiToken("rt", { fetch: stub.fetch });
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toContain("kimi.com");
		expect(creds.access).toBe("at-kimi");
	});

	it("refreshGitLabDuoToken calls options.fetch exactly once against the token endpoint", async () => {
		const stub = makeFetchStub(gitlabTokenBody());
		const creds = await refreshGitLabDuoToken(GITLAB_CREDS, { fetch: stub.fetch });
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toContain("gitlab.com");
		expect(creds.access).toBe("at-gitlab");
	});
});

// ---------------------------------------------------------------------------
// An already-aborted signal stops refresh before any token request
// ---------------------------------------------------------------------------

describe("OAuthRefreshOptions.signal: pre-cancelled signal prevents network call", () => {
	it("refreshAnthropicToken rejects before calling fetch", async () => {
		const stub = makeFetchStub(anthropicTokenBody());
		const ac = new AbortController();
		ac.abort();
		await expect(refreshAnthropicToken("rt", { fetch: stub.fetch, signal: ac.signal })).rejects.toThrow();
		expect(stub.calls).toHaveLength(0);
	});

	it("refreshOpenAICodexToken rejects before calling fetch", async () => {
		const stub = makeFetchStub(codexTokenBody());
		const ac = new AbortController();
		ac.abort();
		await expect(refreshOpenAICodexToken("rt", { fetch: stub.fetch, signal: ac.signal })).rejects.toThrow();
		expect(stub.calls).toHaveLength(0);
	});

	it("refreshKimiToken rejects before calling fetch", async () => {
		const stub = makeFetchStub(kimiTokenBody());
		const ac = new AbortController();
		ac.abort();
		await expect(refreshKimiToken("rt", { fetch: stub.fetch, signal: ac.signal })).rejects.toThrow();
		expect(stub.calls).toHaveLength(0);
	});

	it("refreshGitLabDuoToken rejects before calling fetch", async () => {
		const stub = makeFetchStub(gitlabTokenBody());
		const ac = new AbortController();
		ac.abort();
		await expect(refreshGitLabDuoToken(GITLAB_CREDS, { fetch: stub.fetch, signal: ac.signal })).rejects.toThrow();
		expect(stub.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// A failing token endpoint yields no credentials
// ---------------------------------------------------------------------------

describe("OAuthRefreshOptions: no-network simulation returns zero token responses", () => {
	it("refreshAnthropicToken with a 503 stub throws and returns no credentials", async () => {
		const stub = makeFetchStub(JSON.stringify({ error: "service_unavailable" }), 503);
		await expect(refreshAnthropicToken("rt", { fetch: stub.fetch })).rejects.toThrow();
		expect(stub.calls).toHaveLength(1); // one network attempt, zero tokens issued
	});

	it("refreshKimiToken with a 503 stub throws and returns no credentials", async () => {
		const stub = makeFetchStub(JSON.stringify({ error: "service_unavailable" }), 503);
		await expect(refreshKimiToken("rt", { fetch: stub.fetch })).rejects.toThrow();
		expect(stub.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// A recovery admission rejection from the admitted fetch is not rewrapped
// ---------------------------------------------------------------------------

describe("OAuthRefreshOptions.fetch: recovery admission rejection propagates unchanged", () => {
	function rejectingFetch(error: RecoveryAdmissionError): FetchStub {
		const calls: string[] = [];
		const fn = async (input: string | URL | Request): Promise<Response> => {
			calls.push(String(input instanceof Request ? input.url : input));
			throw error;
		};
		return { fetch: fn as FetchImpl, calls };
	}

	it("refreshAnthropicToken rejects with the same RecoveryAdmissionError instance", async () => {
		const admission = new RecoveryAdmissionError("request_limit");
		const stub = rejectingFetch(admission);
		const outcome = await refreshAnthropicToken("rt", { fetch: stub.fetch }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBe(admission);
		expect(stub.calls).toHaveLength(1);
	});

	it("refreshGlmZcodeToken rejects with the same RecoveryAdmissionError instance instead of a re-login error", async () => {
		const admission = new RecoveryAdmissionError("deadline");
		const stub = rejectingFetch(admission);
		const outcome = await refreshGlmZcodeToken(
			{ access: "old-key", refresh: "upstream-token", expires: 0 },
			{ fetch: stub.fetch },
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(outcome).toBe(admission);
		expect(stub.calls).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// GitHub Copilot refresh is local-only: it accepts the owner options but never sends HTTP
// ---------------------------------------------------------------------------

describe("OAuthRefreshOptions: github-copilot refresh", () => {
	it("refreshOAuthToken forwards options and the refresh sends no request through options.fetch or global fetch", async () => {
		const stub = makeFetchStub("{}");
		const globalFetch = vi.spyOn(globalThis, "fetch");
		try {
			const creds = await refreshOAuthToken(
				"github-copilot",
				{ access: "gho-old", refresh: "gho-token", expires: 0, enterpriseUrl: "ghe.example.com" },
				{ fetch: stub.fetch },
			);
			expect(creds.access).toBe("gho-token");
			expect(creds.refresh).toBe("gho-token");
			expect(creds.enterpriseUrl).toBe("ghe.example.com");
			expect(creds.expires).toBeGreaterThan(Date.now());
			expect(stub.calls).toHaveLength(0);
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			globalFetch.mockRestore();
		}
	});

	it("refreshGitHubCopilotToken rejects a pre-aborted signal with zero network calls", () => {
		const stub = makeFetchStub("{}");
		const globalFetch = vi.spyOn(globalThis, "fetch");
		const ac = new AbortController();
		ac.abort();
		try {
			expect(() =>
				refreshGitHubCopilotToken("gho-token", undefined, { fetch: stub.fetch, signal: ac.signal }),
			).toThrow();
			expect(stub.calls).toHaveLength(0);
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			globalFetch.mockRestore();
		}
	});
});
