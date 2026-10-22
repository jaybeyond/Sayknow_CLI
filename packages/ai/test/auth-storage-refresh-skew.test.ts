import { afterEach, beforeEach, describe, expect, it, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "../src/utils/oauth";
import * as kimiOauth from "../src/utils/oauth/kimi";

// #957
describe("Kimi OAuth token lifetime and proactive credential refresh", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const kimiHeadersStub = {
		"User-Agent": "KimiCLI/0.0.0",
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": "0.0.0",
		"X-Msh-Device-Name": "test",
		"X-Msh-Device-Model": "test",
		"X-Msh-Os-Version": "test",
		"X-Msh-Device-Id": "test",
	} as const;

	it("subtracts the 5-minute skew when parsing Kimi token expiry", async () => {
		// Kimi tokens claim a 60-minute lifetime via `expires_in`, but in
		// practice the server invalidates them roughly 5 minutes earlier than
		// that. parseTokenPayload subtracts OAUTH_EXPIRY_SKEW_MS (5 min) so we
		// schedule the refresh before the real server cutoff.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);

		global.fetch = (async (_input: string | URL, init?: RequestInit) => {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("refresh-0");
			return new Response(
				JSON.stringify({
					access_token: "access-1",
					refresh_token: "refresh-1",
					expires_in: 60 * 60,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const refreshed = await kimiOauth.refreshKimiToken("refresh-0");

		expect(refreshed.access).toBe("access-1");
		expect(refreshed.refresh).toBe("refresh-1");
		expect(refreshed.expires).toBe(issuedAt + 55 * 60 * 1000);
	});

	it("refreshes Kimi credentials through AuthStorage before the local expiry", async () => {
		// End-to-end: a kimi-code OAuth credential that is past the 60s
		// AuthStorage skew must be refreshed automatically via the registered
		// `kimi-code` provider when getApiKey() is called.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt + 54 * 60 * 1000);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);

		let refreshCalls = 0;
		global.fetch = (async (_input: string | URL, init?: RequestInit) => {
			refreshCalls += 1;
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("refresh-stored");
			return new Response(
				JSON.stringify({
					access_token: "access-refreshed",
					refresh_token: "refresh-refreshed",
					expires_in: 60 * 60,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-issue-957-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.set("kimi-code", [
				{
					type: "oauth",
					access: "access-stored",
					refresh: "refresh-stored",
					// Token is still nominally valid (4 min remaining), but
					// within the 60s AuthStorage skew the refresh should fire
					// proactively so we never hand out an expired bearer.
					expires: issuedAt + 55 * 60 * 1000,
				},
			]);

			const apiKey = await authStorage.getApiKey("kimi-code");
			expect(apiKey).toBe("access-refreshed");
			expect(refreshCalls).toBe(1);

			const stored = store.listAuthCredentials("kimi-code");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.access).toBe("access-refreshed");
				expect(stored[0].credential.refresh).toBe("refresh-refreshed");
			}
		} finally {
			store.close();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("AuthStorage OAuth refresh skew", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-refresh-skew-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		unregisterOAuthProviders("auth-storage-refresh-skew-test");
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("refreshes before strict expiry when the credential is inside the 60s skew", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		let refreshCalls = 0;
		const refreshedExpires = Date.now() + 60 * 60_000;
		registerOAuthProvider({
			id: "unit-oauth-skew",
			name: "Unit OAuth Skew",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				return {
					...credentials,
					access: "access-after-skew-refresh",
					refresh: "refresh-after-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew", [
			{
				type: "oauth",
				access: "access-before-skew-refresh",
				refresh: "refresh-before-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const apiKey = await authStorage.getApiKey("unit-oauth-skew", "skew-session");

		expect(apiKey).toBe("access-after-skew-refresh");
		expect(refreshCalls).toBe(1);
		const stored = store.listAuthCredentials("unit-oauth-skew");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.credential.type).toBe("oauth");
		if (stored[0]?.credential.type === "oauth") {
			expect(stored[0].credential.access).toBe("access-after-skew-refresh");
			expect(stored[0].credential.refresh).toBe("refresh-after-skew-refresh");
		}
	});

	test("coalesces concurrent skew refreshes for the same credential", async () => {
		if (!authStorage) throw new Error("test setup failed");

		const refreshedExpires = Date.now() + 60 * 60_000;
		const refreshStarted = Promise.withResolvers<void>();
		const allowRefresh = Promise.withResolvers<void>();
		let refreshCalls = 0;

		registerOAuthProvider({
			id: "unit-oauth-skew-mutex",
			name: "Unit OAuth Skew Mutex",
			sourceId: "auth-storage-refresh-skew-test",
			async login() {
				return { access: "unused", refresh: "unused", expires: refreshedExpires };
			},
			async refreshToken(credentials) {
				refreshCalls += 1;
				refreshStarted.resolve();
				await allowRefresh.promise;
				return {
					...credentials,
					access: "access-after-shared-skew-refresh",
					refresh: "refresh-after-shared-skew-refresh",
					expires: refreshedExpires,
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		await authStorage.set("unit-oauth-skew-mutex", [
			{
				type: "oauth",
				access: "access-before-shared-skew-refresh",
				refresh: "refresh-before-shared-skew-refresh",
				expires: Date.now() + 30_000,
			},
		]);

		const first = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");
		const second = authStorage.getApiKey("unit-oauth-skew-mutex", "same-session");

		await refreshStarted.promise;
		allowRefresh.resolve();

		await expect(first).resolves.toBe("access-after-shared-skew-refresh");
		await expect(second).resolves.toBe("access-after-shared-skew-refresh");
		expect(refreshCalls).toBe(1);
	});
});
