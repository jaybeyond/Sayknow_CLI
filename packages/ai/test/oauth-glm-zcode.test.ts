import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { getBundledModel } from "../src/models";
import {
	buildAnthropicClientOptions,
	buildAnthropicHeaders,
	buildZCodeSourceHeaders,
} from "../src/providers/anthropic";
import { isOAuthToken } from "../src/utils/anthropic-auth";
import { getOAuthProviders, refreshOAuthToken } from "../src/utils/oauth";
import {
	GLM_ZCODE_ANTHROPIC_BASE_URL,
	GLM_ZCODE_OAUTH_AUTHORIZE_URL,
	GLM_ZCODE_OAUTH_BROKER_TOKEN_URL,
	GLM_ZCODE_OAUTH_CLIENT_ID,
	GLM_ZCODE_OAUTH_REDIRECT_URI,
	GlmZcodeOAuthFlow,
	isGlmZcodeOAuthConfigured,
	refreshGlmZcodeToken,
} from "../src/utils/oauth/glm-zcode";
import { withEnv } from "./helpers";

const originalFetch = global.fetch;
const SUPPRESS_ENV = {
	GLM_ZCODE_API_KEY: undefined,
	ZAI_API_KEY: undefined,
	ZCODE_OAUTH_CLIENT_ID: undefined,
} as const;

const ZCODE_JWT = jwt({ sub: "zcode-sub", email: "Z@Example.com" });
const UPSTREAM = "upstream-zai-access-token-1234567890";
const BUSINESS = "business-session-token-abcdefghijklmnop";
const ORG = "org-default-123";
const PROJ = "proj_default_456";
const KEY_ID = "keyid6670babb";
const SECRET = "secretYkn1K3E1a3J";
const MINTED_KEY = `${KEY_ID}.${SECRET}`;

function jwt(payload: Record<string, unknown>): string {
	const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
	return `${enc({ alg: "none" })}.${enc(payload)}.`;
}

interface MockOpts {
	existingKey?: boolean; // api_keys list already contains "zcode-api-key"
	captureCreate?: () => void;
}

function routingFetch(opts: MockOpts = {}) {
	const keysUrl = `https://api.z.ai/api/biz/v1/organization/${ORG}/projects/${PROJ}/api_keys`;
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json" } });
		if (url === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL) {
			return json({ code: 0, data: { token: ZCODE_JWT, zai: { access_token: UPSTREAM } } });
		}
		if (url === "https://api.z.ai/api/auth/z/login") {
			return json({ code: 0, data: { access_token: BUSINESS } });
		}
		if (url === "https://api.z.ai/api/biz/customer/getCustomerInfo") {
			return json({
				code: 200,
				data: {
					id: "5053550",
					email: "member@example.com",
					organizations: [
						{ organizationId: ORG, isDefault: true, projects: [{ projectId: PROJ, isDefault: true }] },
					],
				},
			});
		}
		if (url === keysUrl && method === "GET") {
			return json({ code: 200, data: opts.existingKey ? [{ name: "zcode-api-key", apiKey: KEY_ID }] : [] });
		}
		if (url === keysUrl && method === "POST") {
			opts.captureCreate?.();
			return json({ code: 200, data: { apiKey: KEY_ID } });
		}
		if (url === `${keysUrl}/copy/${KEY_ID}`) {
			return json({ code: 200, data: { secretKey: SECRET } });
		}
		throw new Error(`Unexpected fetch: ${method} ${url}`);
	});
}

describe("GLM ZCode OAuth login provider", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-glm-zcode-oauth-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("registers glm-zcode as an available, opt-in-labeled login provider", () => {
		expect(getOAuthProviders().find(p => p.id === "glm-zcode")).toEqual({
			id: "glm-zcode",
			name: "GLM ZCode OAuth (unofficial, opt-in)",
			available: true,
		});
		expect(isGlmZcodeOAuthConfigured()).toBe(true);
	});

	it("uses the exact ZCode client id, custom redirect, and api.z.ai model base", () => {
		expect(GLM_ZCODE_OAUTH_CLIENT_ID).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
		expect(GLM_ZCODE_OAUTH_REDIRECT_URI).toBe("zcode://oauth/callback");
		expect(GLM_ZCODE_ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
		expect(getBundledModel("glm-zcode", "glm-5.2").baseUrl).toBe("https://api.z.ai/api/anthropic");
	});

	it("builds the authorize URL with client id, custom redirect, response_type, and state", async () => {
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: routingFetch() as unknown as typeof fetch },
		);
		const { url, instructions } = await flow.generateAuthUrl("state-1", GLM_ZCODE_OAUTH_REDIRECT_URI);
		const authUrl = new URL(url);
		expect(authUrl.origin + authUrl.pathname).toBe(GLM_ZCODE_OAUTH_AUTHORIZE_URL);
		expect(authUrl.searchParams.get("client_id")).toBe(GLM_ZCODE_OAUTH_CLIENT_ID);
		expect(authUrl.searchParams.get("redirect_uri")).toBe(GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("state")).toBe("state-1");
		expect(instructions ?? "").toMatch(/unofficial/i);
	});

	it("exchanges the code and provisions a Z.AI API key as the credential", async () => {
		let created = false;
		const fetchMock = routingFetch({ captureCreate: () => (created = true) });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-1", GLM_ZCODE_OAUTH_REDIRECT_URI);
		// access is the minted "{id}.{secret}" Z.AI API key — NOT a JWT.
		expect(credentials.access).toBe(MINTED_KEY);
		expect(credentials.access.split(".")).toHaveLength(2);
		expect(credentials.refresh).toBe(UPSTREAM);
		expect(credentials.email).toBe("member@example.com");
		expect(credentials.expires).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000); // long-lived
		expect(created).toBe(true); // no existing key → created one
		// hit the provisioning endpoints
		const urls = fetchMock.mock.calls.map(c => String(c[0]));
		expect(urls.some(u => u.includes("/api/biz/customer/getCustomerInfo"))).toBe(true);
		expect(urls.some(u => u.includes("/api_keys/copy/"))).toBe(true);
	});

	it("reuses an existing zcode-api-key without creating a new one", async () => {
		let created = false;
		const fetchMock = routingFetch({ existingKey: true, captureCreate: () => (created = true) });
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken("auth-code", "state-1", GLM_ZCODE_OAUTH_REDIRECT_URI);
		expect(credentials.access).toBe(MINTED_KEY);
		expect(created).toBe(false);
	});

	it("accepts a pasted full zcode:// redirect URL as the code", async () => {
		const fetchMock = routingFetch();
		const flow = new GlmZcodeOAuthFlow(
			{ onAuth: () => {}, onPrompt: async () => "" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		const credentials = await flow.exchangeToken(
			"zcode://oauth/callback?code=pasted&state=state-1",
			"state-1",
			GLM_ZCODE_OAUTH_REDIRECT_URI,
		);
		expect(credentials.access).toBe(MINTED_KEY);
		const brokerCall = fetchMock.mock.calls.find(c => String(c[0]) === GLM_ZCODE_OAUTH_BROKER_TOKEN_URL);
		expect(JSON.parse(String((brokerCall?.[1] as RequestInit).body)).code).toBe("pasted");
	});

	it("refresh re-provisions the API key from the stored upstream token", async () => {
		const fetchMock = routingFetch({ existingKey: true });
		const refreshed = await refreshGlmZcodeToken(
			{ access: "old", refresh: UPSTREAM, expires: Date.now() - 1 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(refreshed.access).toBe(MINTED_KEY);
		expect(refreshed.refresh).toBe(UPSTREAM);
	});

	it("refresh fails with a re-login error when no upstream token is stored", async () => {
		await expect(refreshGlmZcodeToken({ access: "x", refresh: "", expires: Date.now() - 1 })).rejects.toThrow(
			/re-login/i,
		);
	});

	it("dispatches refreshOAuthToken('glm-zcode') to re-provisioning", async () => {
		const fetchMock = routingFetch({ existingKey: true });
		global.fetch = fetchMock as unknown as typeof fetch;
		const refreshed = await refreshOAuthToken("glm-zcode", {
			access: "old",
			refresh: UPSTREAM,
			expires: Date.now() - 1,
		});
		expect(refreshed.access).toBe(MINTED_KEY);
	});

	it("stores glm-zcode login as OAuth and getApiKey returns the provisioned key", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;
		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});
		const creds = store.listAuthCredentials("glm-zcode");
		expect(creds).toHaveLength(1);
		expect(creds[0]?.credential).toMatchObject({ type: "oauth", access: MINTED_KEY, refresh: UPSTREAM });
		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("glm-zcode", "session-glm")).toBe(MINTED_KEY);
		});
	});

	it("coexists with the legacy zai API-key provider without cross-contamination", async () => {
		if (!store || !authStorage) throw new Error("test setup failed");
		const fetchMock = routingFetch();
		global.fetch = fetchMock as unknown as typeof fetch;
		await authStorage.set("zai", { type: "api_key", key: "legacy-zai-key" });
		let capturedState: string | undefined;
		await authStorage.login("glm-zcode", {
			onAuth: info => {
				capturedState = new URL(info.url).searchParams.get("state") ?? undefined;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `zcode://oauth/callback?code=login-code&state=${capturedState ?? ""}`,
		});
		expect(store.listAuthCredentials("zai")[0]?.credential).toMatchObject({ type: "api_key" });
		expect(store.listAuthCredentials("glm-zcode")[0]?.credential).toMatchObject({ type: "oauth" });
		await withEnv(SUPPRESS_ENV, async () => {
			expect(await authStorage?.getApiKey("zai", "s-zai")).toBe("legacy-zai-key");
			expect(await authStorage?.getApiKey("glm-zcode", "s-glm")).toBe(MINTED_KEY);
		});
	});

	it("exposes a statically bundled glm-zcode/glm-5.2 model selectable without live credentials", () => {
		const model = getBundledModel("glm-zcode", "glm-5.2");
		expect(model).toBeDefined();
		expect(model.provider).toBe("glm-zcode");
		expect(model.api).toBe("anthropic-messages");
	});

	it("pins the request base to api.z.ai even if model.baseUrl was polluted", () => {
		const model = {
			id: "glm-5.2",
			name: "GLM-5.2 (ZCode)",
			api: "anthropic-messages",
			provider: "glm-zcode",
			baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131072,
		} as unknown as Parameters<typeof buildAnthropicClientOptions>[0]["model"];
		const resolved = buildAnthropicClientOptions({ model, apiKey: MINTED_KEY });
		expect(resolved.baseURL).toBe("https://api.z.ai/api/anthropic");
		expect(resolved.isOAuthToken).toBe(false);
	});

	it("sends Authorization: Bearer (no x-api-key, no claude-cli UA, no isOAuth) for the API key", () => {
		expect(isOAuthToken(MINTED_KEY)).toBe(false);
		const headers = buildAnthropicHeaders({ apiKey: MINTED_KEY, baseUrl: GLM_ZCODE_ANTHROPIC_BASE_URL });
		expect(headers.Authorization).toBe(`Bearer ${MINTED_KEY}`);
		expect(headers["X-Api-Key"]).toBeUndefined();
		expect((headers["User-Agent"] ?? "").toLowerCase().startsWith("claude-cli")).toBe(false);
	});

	it("attaches ZCode client source headers so api.z.ai recognizes the ZCode client", () => {
		const headers = buildAnthropicHeaders({
			apiKey: MINTED_KEY,
			baseUrl: GLM_ZCODE_ANTHROPIC_BASE_URL,
			zcodeSourceHeaders: true,
		});
		expect(headers["User-Agent"]).toBe("ZCode/3.1.2");
		expect(headers["X-Title"]).toBe("Z Code@electron");
		expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
		expect(headers["X-ZCode-Agent"]).toBe("glm");
		expect(headers["X-ZCode-App-Version"]).toBe("3.1.2");
		expect(headers["X-Release-Channel"]).toBe("production");
		expect(headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`);
		expect(headers["X-Os-Category"]).toMatch(/^(macos|windows|linux)$/);
		expect(headers["X-Client-Language"]).toBeDefined();
		expect(headers["X-Client-Timezone"]).toBeDefined();
		// still a bearer API-key request, never x-api-key or claude-cli
		expect(headers.Authorization).toBe(`Bearer ${MINTED_KEY}`);
		expect(headers["X-Api-Key"]).toBeUndefined();
	});

	it("emits printable-only ZCode source headers from buildZCodeSourceHeaders()", () => {
		const headers = buildZCodeSourceHeaders();
		for (const value of Object.values(headers)) {
			expect(value).toMatch(/^[\x20-\x7e]+$/);
		}
		expect(headers["X-ZCode-Agent"]).toBe("glm");
	});

	it("includes the ZCode source headers in glm-zcode client default headers", () => {
		const model = getBundledModel("glm-zcode", "glm-5.2") as Parameters<
			typeof buildAnthropicClientOptions
		>[0]["model"];
		const resolved = buildAnthropicClientOptions({ model, apiKey: MINTED_KEY });
		expect(resolved.defaultHeaders?.["User-Agent"]).toBe("ZCode/3.1.2");
		expect(resolved.defaultHeaders?.["X-ZCode-Agent"]).toBe("glm");
	});

	it("does NOT attach ZCode source headers when the flag is off (e.g. legacy zai)", () => {
		const headers = buildAnthropicHeaders({ apiKey: MINTED_KEY, baseUrl: "https://api.z.ai/api/anthropic" });
		expect(headers["X-ZCode-Agent"]).toBeUndefined();
		expect(headers["User-Agent"] ?? "").not.toBe("ZCode/3.1.2");
	});
});
