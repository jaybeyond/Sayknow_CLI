import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { oauthCredentialSchema, remoteOauthCredentialSchema } from "../src/auth-broker/wire-schemas";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "../src/auth-storage";

describe("MCP OAuth credential binding persistence", () => {
	let tempDir = "";

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = "";
	});

	test("preserves the bound MCP and token endpoints across storage reopen", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-origin-"));
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "mcp_oauth_test";
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		firstStore.replaceAuthCredentialsForProvider(provider, [
			{
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 60_000,
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://auth.example/token",
				},
			},
		]);
		firstStore.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(reopenedStore.listAuthCredentials(provider)[0]?.credential).toMatchObject({
				type: "oauth",
				mcpBinding: {
					resourceOrigin: "https://mcp.example",
					tokenEndpoint: "https://auth.example/token",
				},
			});
		} finally {
			reopenedStore.close();
		}
	});

	test("rejects malformed or noncanonical bindings on upload, snapshot, and refresh", async () => {
		const invalidBindings = [
			{ resourceOrigin: "not-a-url", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://user@mcp.example", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://mcp.example/", tokenEndpoint: "https://auth.example/token" },
			{ resourceOrigin: "https://mcp.example", tokenEndpoint: "https://auth.example:443/token" },
			{ resourceOrigin: "https://mcp.example", tokenEndpoint: "https://user:pass@auth.example/token" },
		];
		for (const mcpBinding of invalidBindings) {
			const credential = { type: "oauth" as const, access: "access", expires: 0, mcpBinding };
			expect(oauthCredentialSchema.safeParse({ ...credential, refresh: "refresh" }).success).toBe(false);
			expect(
				remoteOauthCredentialSchema.safeParse({ ...credential, refresh: REMOTE_REFRESH_SENTINEL }).success,
			).toBe(false);
		}

		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-invalid-binding-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set("mcp_oauth_invalid", {
			type: "oauth",
			access: "old-access",
			refresh: "refresh",
			expires: 0,
			mcpBinding: invalidBindings[4],
		});
		const credential = storage.get("mcp_oauth_invalid");
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			await expect(storage.forceRefreshOAuthCredential("mcp_oauth_invalid", credential)).rejects.toThrow(
				"Invalid MCP OAuth credential binding",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("refreshes a local MCP credential through its stored token endpoint and preserves its binding", async () => {
		let requestBody = "";
		const tokenServer = Bun.serve({
			port: 0,
			async fetch(request) {
				requestBody = await request.text();
				return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-refresh-"));
		const dbPath = path.join(tempDir, "agent.db");
		const provider = "mcp_oauth_local";
		const binding = {
			resourceOrigin: "https://mcp.example",
			tokenEndpoint: tokenServer.url.href,
		};
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(dbPath));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "local-refresh-secret",
			expires: Date.now() - 1,
			mcpBinding: binding,
		});

		try {
			const credential = storage.get(provider);
			if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
			const refreshed = await storage.forceRefreshOAuthCredential(provider, credential, {
				clientId: "bound-client",
				clientSecret: "bound-secret",
			});
			expect(refreshed).toMatchObject({ access: "new-access", mcpBinding: binding });
			expect(requestBody).toContain("refresh_token=local-refresh-secret");
			expect(requestBody).toContain("client_id=bound-client");
			expect(requestBody).toContain("client_secret=bound-secret");
			expect(storage.get(provider)).toMatchObject({
				access: "new-access",
				refresh: "new-refresh",
				mcpBinding: binding,
			});
		} finally {
			storage.close();
			await tokenServer.stop(true);
		}
	});

	test("rejects 307 and 308 redirects without forwarding MCP refresh credentials", async () => {
		const forwardedBodies: string[] = [];
		const redirectTarget = Bun.serve({
			port: 0,
			async fetch(request) {
				forwardedBodies.push(await request.text());
				return Response.json({ access_token: "attacker-access" });
			},
		});
		let redirectStatus = 307;
		let tokenEndpointCalls = 0;
		const tokenServer = Bun.serve({
			port: 0,
			fetch() {
				tokenEndpointCalls++;
				return new Response(null, {
					status: redirectStatus,
					headers: { Location: redirectTarget.url.href },
				});
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-redirect-"));
		const provider = "mcp_oauth_redirect";
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "redirect-refresh-secret",
			expires: 0,
			mcpBinding: {
				resourceOrigin: "https://mcp.example",
				tokenEndpoint: tokenServer.url.href,
			},
		});

		try {
			for (redirectStatus of [307, 308]) {
				const credential = storage.get(provider);
				if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
				await expect(
					storage.forceRefreshOAuthCredential(
						provider,
						credential,
						{ clientId: "redirect-client", clientSecret: "redirect-client-secret" },
						undefined,
					),
				).rejects.toThrow(`MCP OAuth refresh rejected redirect response (${redirectStatus})`);
			}
			expect(tokenEndpointCalls).toBe(2);
			expect(forwardedBodies).toEqual([]);
			expect(storage.get(provider)).toMatchObject({
				access: "old-access",
				refresh: "redirect-refresh-secret",
			});
		} finally {
			storage.close();
			await tokenServer.stop(true);
			await redirectTarget.stop(true);
		}
	});

	test("passes caller cancellation to the bound token fetch", async () => {
		const fetchStarted = Promise.withResolvers<AbortSignal>();
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestSignal = init?.signal;
			if (!requestSignal) throw new Error("expected refresh fetch signal");
			fetchStarted.resolve(requestSignal);
			const pending = Promise.withResolvers<void>();
			const rejectOnAbort = (): void => pending.reject(new Error("token request aborted"));
			if (requestSignal.aborted) {
				rejectOnAbort();
			} else {
				requestSignal.addEventListener("abort", rejectOnAbort, { once: true });
			}
			await pending.promise;
			return Response.json({ access_token: "unexpected-access" });
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-abort-"));
		const provider = "mcp_oauth_abort";
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "abort-refresh-secret",
			expires: 0,
			mcpBinding: {
				resourceOrigin: "https://mcp.example",
				tokenEndpoint: "https://auth.example/token",
			},
		});
		const credential = storage.get(provider);
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		const controller = new AbortController();

		try {
			const refresh = storage.forceRefreshOAuthCredential(provider, credential, {}, controller.signal);
			expect(await fetchStarted.promise).toBe(controller.signal);
			controller.abort();
			await expect(refresh).rejects.toThrow("credential refresh aborted");
			expect(storage.get(provider)).toMatchObject({
				access: "old-access",
				refresh: "abort-refresh-secret",
			});
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("rejects invalid refresh payloads through AuthStorage without persisting them", async () => {
		let payload: unknown;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((async () => Response.json(payload)) as unknown as typeof fetch);
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-invalid-refresh-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		await storage.set("mcp_oauth_invalid_refresh", {
			type: "oauth",
			access: "old-access",
			refresh: "refresh",
			expires: 0,
			mcpBinding: { resourceOrigin: "https://mcp.example", tokenEndpoint: "https://auth.example/token" },
		});
		const credential = storage.get("mcp_oauth_invalid_refresh");
		if (credential?.type !== "oauth") throw new Error("expected OAuth credential");
		try {
			for (payload of [
				null,
				{},
				{ access_token: 1 },
				{ access_token: "" },
				{ access_token: "access", refresh_token: 1 },
				{ access_token: "access", expires_in: "3600" },
				{ access_token: "access", expires_in: -1 },
			]) {
				await expect(
					storage.forceRefreshOAuthCredential("mcp_oauth_invalid_refresh", credential),
				).rejects.toThrow();
				const stored = storage.get("mcp_oauth_invalid_refresh");
				expect(stored?.type === "oauth" ? stored.access : undefined).toBe("old-access");
			}
		} finally {
			storage.close();
			fetchSpy.mockRestore();
		}
	});

	test("refreshes the exact requested credential when a provider has multiple rows", async () => {
		let firstCalls = 0;
		let secondCalls = 0;
		const firstServer = Bun.serve({
			port: 0,
			fetch() {
				firstCalls++;
				return Response.json({ access_token: "wrong-access" });
			},
		});
		const secondServer = Bun.serve({
			port: 0,
			fetch() {
				secondCalls++;
				return Response.json({ access_token: "second-access" });
			},
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-oauth-exact-"));
		const storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await storage.reload();
		const first = {
			type: "oauth" as const,
			access: "first-old",
			refresh: "first-refresh",
			expires: 0,
			accountId: "first",
			mcpBinding: { resourceOrigin: "https://first.example", tokenEndpoint: firstServer.url.href },
		};
		const second = {
			type: "oauth" as const,
			access: "second-old",
			refresh: "second-refresh",
			expires: 0,
			accountId: "second",
			mcpBinding: { resourceOrigin: "https://second.example", tokenEndpoint: secondServer.url.href },
		};
		await storage.set("mcp_oauth_multiple", [first, second]);

		try {
			const refreshed = await storage.forceRefreshOAuthCredential("mcp_oauth_multiple", second);
			expect(refreshed.access).toBe("second-access");
			expect(firstCalls).toBe(0);
			expect(secondCalls).toBe(1);
		} finally {
			storage.close();
			await firstServer.stop(true);
			await secondServer.stop(true);
		}
	});
});
