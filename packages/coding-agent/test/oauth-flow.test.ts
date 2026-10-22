import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { hookFetch } from "../../utils/src/hook-fetch";
import { MCPOAuthFlow } from "../src/runtime-mcp/oauth-flow";
import { assertPublicOAuthUrl } from "../src/runtime-mcp/oauth-public-url";

/** Logical URL after guardedPublicFetch pins the dial to a resolved address. */
function observedUrl(input: string | URL | Request, init?: RequestInit): URL {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const wire = new URL(raw);
	const hostHeader = init?.headers === undefined ? null : new Headers(init.headers).get("host");
	const wireHost = wire.hostname.replace(/^\[|\]$/g, "");
	if (hostHeader && net.isIP(wireHost) !== 0) {
		const logical = new URL(wire.href);
		logical.host = hostHeader;
		return logical;
	}
	return wire;
}

const originalFetch = global.fetch;

beforeEach(() => {
	// Token URLs in this file are fictional. The public-URL check resolves them
	// before fetch, and these tests already mock that fetch.
	vi.spyOn(dns, "lookup").mockImplementation(((...args: unknown[]) => {
		const options = args[1];
		if (options && typeof options === "object" && "all" in options && options.all === true) {
			return Promise.resolve([{ address: "1.1.1.1", family: 4 }]);
		}
		return Promise.resolve({ address: "1.1.1.1", family: 4 });
	}) as typeof dns.lookup);
});

afterEach(() => {
	vi.restoreAllMocks();
	global.fetch = originalFetch;
});

async function dispatchLocalCallback(callbackUrl: string): Promise<void> {
	const url = new URL(callbackUrl);
	url.hostname = "127.0.0.1";
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await originalFetch(url.toString());
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(10);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Reserve an OS-assigned loopback port for the OAuth callback server.
 *
 * The reservation is closed before MCPOAuthFlow re-binds the port, which
 * leaves a narrow close-then-rebind TOCTOU window. This is an accepted
 * test-only tradeoff: an intervening claimant causes an honest bind
 * failure/timeout, never a false pass, and eliminating it entirely would
 * require the production callback API to accept a pre-bound listener.
 * Do not replace this with hardcoded ports or retries.
 */
function allocateCallbackPort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response("reserved callback port");
		},
	});
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Expected callback port");
	return port;
}

function mockProviderTokenEndpoint(onBody: (body: string) => void) {
	return hookFetch((input, init) => {
		const url = observedUrl(input, init);
		if (url.origin === "https://provider.example" && url.pathname === "/token") {
			onBody(String(init?.body ?? ""));
			return new Response(
				JSON.stringify({
					access_token: "access-token",
					refresh_token: "refresh-token",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}

		throw new Error(`Unexpected fetch: ${url.href}`);
	});
}

describe("mcp oauth flow", () => {
	it("uses Codex client name for dynamic client registration", async () => {
		let registrationPayload: Record<string, unknown> | null = null;

		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.origin === "https://www.figma.com" && url.pathname === "/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({ registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.origin === "https://api.figma.com" && url.pathname === "/v1/oauth/mcp/register") {
				registrationPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						client_id: "registered-client-id",
						client_secret: "registered-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
			},
			{},
		);

		const { url } = await flow.generateAuthUrl("test-state", "http://127.0.0.1:53172/callback");
		const authUrl = new URL(url);

		expect(registrationPayload).not.toBeNull();
		expect((registrationPayload as { client_name?: string } | null)?.client_name).toBe("Codex");
		expect(authUrl.searchParams.get("client_id")).toBe("registered-client-id");
		expect(authUrl.searchParams.get("state")).toBe("test-state");
	});

	it("does not fetch registration metadata from a non-public authorization origin", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(input => {
			urls.push(String(input));
			return new Response("{}", { status: 200 });
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "http://127.0.0.1/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
		expect(urls.some(url => url.includes("oauth-authorization-server"))).toBe(false);
	});

	it("does not GET a loopback authorization URL while probing for client_id", async () => {
		const hits: { method: string; path: string; accept: string | null }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				hits.push({
					method: request.method,
					path: url.pathname,
					accept: request.headers.get("accept"),
				});
				return new Response("ok", { status: 200 });
			},
		});
		const port = server.port;
		if (port === undefined) {
			server.stop(true);
			throw new Error("Expected authorize server port");
		}
		const authorizationUrl = `http://127.0.0.1:${port}/authorize`;
		try {
			await expect(assertPublicOAuthUrl(authorizationUrl)).rejects.toThrow(/Refusing non-public OAuth endpoint/);
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl,
					tokenUrl: "https://provider.example/token",
				},
				{},
			);
			const { url } = await flow.generateAuthUrl("state-probe", "http://127.0.0.1:9/callback");
			expect(hits).toEqual([]);
			const parsed = new URL(url);
			expect(parsed.origin).toBe(`http://127.0.0.1:${port}`);
			expect(parsed.pathname).toBe("/authorize");
			expect(parsed.searchParams.get("client_id")).toBeNull();
		} finally {
			server.stop(true);
		}
	});

	it("does not GET an authorization host that resolves to a private address", async () => {
		const lookup = vi.spyOn(dns, "lookup");
		lookup.mockImplementation((async (hostname: string, options?: unknown) => {
			const address = hostname === "rebind.example" ? "10.1.2.3" : "1.1.1.1";
			if (options && typeof options === "object" && "all" in options && options.all === true) {
				return [{ address, family: 4 }];
			}
			return { address, family: 4 };
		}) as typeof dns.lookup);
		const urls: string[] = [];
		using _hook = hookFetch(input => {
			urls.push(String(input));
			return new Response("ok", { status: 200 });
		});
		const authorizationUrl = "https://rebind.example/authorize";
		await expect(assertPublicOAuthUrl(authorizationUrl)).rejects.toThrow(/private or reserved address/);
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl,
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
		expect(urls.filter(seen => seen.includes("rebind.example"))).toEqual([]);
		expect(new URL(url).hostname).toBe("rebind.example");
		expect(new URL(url).searchParams.get("client_id")).toBeNull();
	});

	it("does not GET link-local, private, IPv6 loopback, or 6to4 anycast authorization URLs", async () => {
		const targets = [
			"http://10.0.0.8/authorize",
			"http://169.254.169.254/latest/meta-data",
			"http://[::1]/authorize",
			"http://192.88.99.2/authorize",
		];
		for (const authorizationUrl of targets) {
			const urls: string[] = [];
			const hook = hookFetch(input => {
				urls.push(String(input));
				return new Response("client_id is required", { status: 400 });
			});
			try {
				await expect(assertPublicOAuthUrl(authorizationUrl)).rejects.toThrow(/Refusing non-public OAuth endpoint/);
				const flow = new MCPOAuthFlow(
					{
						authorizationUrl,
						tokenUrl: "https://provider.example/token",
					},
					{},
				);
				const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
				const host = new URL(authorizationUrl).host;
				expect(urls.filter(seen => seen.includes(host))).toEqual([]);
				expect(new URL(url).host).toBe(host);
			} finally {
				hook[Symbol.dispose]();
			}
		}
	});

	it("still probes a public authorization URL that requires client_id", async () => {
		let probed = false;
		using _hook = hookFetch((input, init) => {
			const wire = new URL(String(input));
			const url = observedUrl(input, init);
			if (url.pathname === "/authorize") {
				probed = true;
				expect(wire.hostname).toBe("1.1.1.1");
				expect(new Headers(init?.headers).get("host")).toBe("provider.example");
				return new Response("error: client_id is required", { status: 400 });
			}
			if (url.origin === "https://provider.example" && url.pathname === "/.well-known/oauth-authorization-server") {
				return new Response("{}", { status: 404 });
			}
			throw new Error(`Unexpected fetch: ${url.href}`);
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		await expect(flow.generateAuthUrl("state", "http://127.0.0.1:9/callback")).rejects.toThrow(
			"OAuth provider requires client_id",
		);
		expect(probed).toBe(true);
	});

	it("pins the client_id probe GET to the address that passed validation", async () => {
		let allLookups = 0;
		vi.spyOn(dns, "lookup").mockImplementation((async (hostname: string, options?: unknown) => {
			const all = options && typeof options === "object" && "all" in options && options.all === true;
			if (hostname === "rebind.example" && all) {
				allLookups += 1;
				if (allLookups === 1) return [{ address: "1.1.1.1", family: 4 }];
				if (allLookups === 2) return [{ address: "9.9.9.9", family: 4 }];
				if (allLookups === 3) return [{ address: "8.8.8.8", family: 4 }];
				return [{ address: "10.9.8.7", family: 4 }];
			}
			if (all) return [{ address: "1.1.1.1", family: 4 }];
			return { address: "1.1.1.1", family: 4 };
		}) as typeof dns.lookup);
		const seen: { href: string; host: string | null }[] = [];
		using _hook = hookFetch((input, init) => {
			const href = String(input);
			seen.push({ href, host: new Headers(init?.headers).get("host") });
			if (href.includes("/.well-known/oauth-authorization-server")) {
				return new Response("{}", { status: 404 });
			}
			if (new URL(href).pathname === "/authorize") {
				return new Response("ok", { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${href}`);
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://rebind.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
		const probe = seen.filter(item => new URL(item.href).pathname === "/authorize");
		expect(probe).toHaveLength(1);
		expect(new URL(probe[0]?.href ?? "http://invalid").hostname).toBe("8.8.8.8");
		expect(probe[0]?.host).toBe("rebind.example");
		expect(allLookups).toBe(3);
		expect(new URL(url).hostname).toBe("rebind.example");
		expect(new URL(url).searchParams.get("client_id")).toBeNull();
	});

	it("does not probe a non-public authorization URL that already has a client_id", async () => {
		const hits: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				hits.push(new URL(request.url).pathname);
				return new Response("ok", { status: 200 });
			},
		});
		const port = server.port;
		if (port === undefined) {
			server.stop(true);
			throw new Error("Expected authorize server port");
		}
		try {
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: `http://127.0.0.1:${port}/authorize`,
					tokenUrl: "https://provider.example/token",
					clientId: "client-id",
				},
				{},
			);
			const { url } = await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
			expect(hits).toEqual([]);
			expect(new URL(url).searchParams.get("client_id")).toBe("client-id");
		} finally {
			server.stop(true);
		}
	});

	it("does not follow redirects when fetching public registration metadata", async () => {
		let metadataRedirect: string | undefined;
		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.origin === "https://provider.example" && url.pathname === "/.well-known/oauth-authorization-server") {
				metadataRedirect = init?.redirect;
				return new Response(JSON.stringify({ registration_endpoint: "https://provider.example/register" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.origin === "https://provider.example" && url.pathname === "/register") {
				return new Response(JSON.stringify({ client_id: "cid" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		await flow.generateAuthUrl("state", "http://127.0.0.1:9/callback");
		expect(metadataRedirect).toBe("manual");
	});

	it("uses configured callbackPath for the local redirect URI", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				callbackPort,
				callbackPath: "slack/oauth_redirect",
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(`${observedRedirectUri}?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const redirectUrl = new URL(observedRedirectUri);
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(redirectUrl.pathname).toBe("/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe(observedRedirectUri);
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("uses exact redirectUri and clientSecret for provider requests", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort,
				callbackPath: "slack/oauth_redirect",
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(
							`http://127.0.0.1:${callbackPort}/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example/slack/oauth_redirect");
		expect(tokenParams.get("client_secret")).toBe("client-secret");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("preserves root redirectUri values without adding a trailing slash", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				redirectUri: "https://public.example",
				callbackPort,
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(`http://127.0.0.1:${callbackPort}/?code=test-code&state=${state}`);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://public.example");
		expect(tokenParams.get("redirect_uri")).toBe("https://public.example");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("supports https loopback redirectUri values behind a separate local callback port", async () => {
		let observedRedirectUri = "";
		let tokenRequestBody = "";

		using _hook = mockProviderTokenEndpoint(body => {
			tokenRequestBody = body;
		});

		const callbackPort = allocateCallbackPort();

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://localhost:3443/slack/oauth_redirect",
				callbackPort,
			},
			{
				onAuth: info => {
					const authUrl = new URL(info.url);
					observedRedirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
					const state = authUrl.searchParams.get("state") ?? "";
					queueMicrotask(() => {
						void dispatchLocalCallback(
							`http://127.0.0.1:${callbackPort}/slack/oauth_redirect?code=test-code&state=${state}`,
						);
					});
				},
				signal: AbortSignal.timeout(1_000),
			},
		);

		const credentials = await flow.login();
		const tokenParams = new URLSearchParams(tokenRequestBody);

		expect(observedRedirectUri).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(tokenParams.get("redirect_uri")).toBe("https://localhost:3443/slack/oauth_redirect");
		expect(credentials).toMatchObject({
			access: "access-token",
			refresh: "refresh-token",
		});
	});

	it("rejects https loopback redirectUri values without a separate callback port", () => {
		expect(
			() =>
				new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						tokenUrl: "https://provider.example/token",
						redirectUri: "https://localhost:3000/slack/oauth_redirect",
					},
					{},
				),
		).toThrow("HTTPS loopback redirect URIs require oauth.callbackPort");
	});

	it("listens on the implied port for exact HTTP loopback redirectUri values", async () => {
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 80 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: 80 });
	});

	it("listens on the explicit port for exact HTTP loopback redirectUri values", async () => {
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "http://localhost:3000/callback",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow(
			"OAuth callback port 3000 unavailable; cannot fall back to a random port when oauth.redirectUri is set",
		);
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: 3000 });
	});

	it("fails instead of falling back to a random port when redirectUri is exact", async () => {
		const callbackPort = allocateCallbackPort();
		let servedOptions: { hostname?: string; port?: number | string } | undefined;
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(options => {
			servedOptions = { hostname: options.hostname, port: options.port };
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				redirectUri: "https://public.example/slack/oauth_redirect",
				callbackPort,
				callbackPath: "/slack/oauth_redirect",
			},
			{ signal: AbortSignal.timeout(1_000) },
		);

		await expect(flow.login()).rejects.toThrow("cannot fall back to a random port when oauth.redirectUri is set");
		expect(serveSpy).toHaveBeenCalledTimes(1);
		expect(servedOptions).toMatchObject({ hostname: "127.0.0.1", port: callbackPort });
	});

	it("exposes the dynamically registered client_id and client_secret after generateAuthUrl", async () => {
		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.origin === "https://www.figma.com" && url.pathname === "/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({ registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.origin === "https://api.figma.com" && url.pathname === "/v1/oauth/mcp/register") {
				return new Response(
					JSON.stringify({
						client_id: "registered-client-id",
						client_secret: "registered-client-secret",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://www.figma.com/oauth/mcp",
				tokenUrl: "https://api.figma.com/v1/oauth/token",
			},
			{},
		);

		expect(flow.resolvedClientId).toBeUndefined();
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53173/callback");

		expect(flow.resolvedClientId).toBe("registered-client-id");
		expect(flow.registeredClientSecret).toBe("registered-client-secret");
	});

	it("returns the configured client_id from resolvedClientId without triggering registration", async () => {
		let registrationCalled = false;
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.includes("/.well-known/")) {
				return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (url.endsWith("/register")) {
				registrationCalled = true;
			}
			return new Response("not found", { status: 404 });
		});

		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "configured-client-id",
			},
			{},
		);

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();

		await flow.generateAuthUrl("test-state", "http://127.0.0.1:53174/callback");

		expect(flow.resolvedClientId).toBe("configured-client-id");
		expect(flow.registeredClientSecret).toBeUndefined();
		expect(registrationCalled).toBe(false);
	});

	function mockLookup(resolveAddress: (hostname: string, lookupIndex: number) => string) {
		const counts = new Map<string, number>();
		vi.spyOn(dns, "lookup").mockImplementation((async (hostname: string, options?: unknown) => {
			const lookupIndex = (counts.get(hostname) ?? 0) + 1;
			counts.set(hostname, lookupIndex);
			const address = resolveAddress(hostname, lookupIndex);
			if (options && typeof options === "object" && "all" in options && options.all === true) {
				return [{ address, family: 4 }];
			}
			return { address, family: 4 };
		}) as typeof dns.lookup);
		return counts;
	}

	function listenForPrivateHits() {
		const hits: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				hits.push(await request.text());
				return Response.json({
					access_token: "stolen",
					refresh_token: "stolen",
					expires_in: 60,
					client_id: "stolen-client",
					client_secret: "stolen-secret",
				});
			},
		});
		const port = server.port;
		if (port === undefined) {
			server.stop(true);
			throw new Error("Expected private mock port");
		}
		return { server, hits, port };
	}

	it("does not dial a private mock when the token host rebinds after a public lookup", async () => {
		const { server, hits, port } = listenForPrivateHits();
		const wire: string[] = [];
		try {
			mockLookup((hostname, lookupIndex) =>
				hostname === "token.example" && lookupIndex >= 2 ? "127.0.0.1" : "8.8.8.8",
			);
			using _hook = hookFetch((input, init, next) => {
				const href = String(input);
				wire.push(href);
				if (new URL(href).hostname === "127.0.0.1") return next(input, init);
				return Response.json({ access_token: "should-not-issue", refresh_token: "no", expires_in: 60 });
			});
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: "https://provider.example/authorize",
					tokenUrl: `http://token.example:${port}/token`,
					clientId: "client-id",
					clientSecret: "client-secret",
				},
				{},
			);
			await expect(
				flow.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback"),
			).rejects.toThrow(/Refusing non-public OAuth endpoint/);
			expect(hits).toEqual([]);
			expect(wire.some(href => new URL(href).hostname === "127.0.0.1")).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("exchanges a code with a public token endpoint pinned to the validated address", async () => {
		const { server, hits, port } = listenForPrivateHits();
		try {
			mockLookup(() => "8.8.8.8");
			let body = "";
			using _hook = hookFetch((input, init, next) => {
				const wire = new URL(String(input));
				if (wire.hostname === "127.0.0.1") return next(input, init);
				expect(wire.hostname).toBe("8.8.8.8");
				expect(wire.pathname).toBe("/token");
				expect(wire.port).toBe(String(port));
				expect(new Headers(init?.headers).get("host")).toBe(`token.example:${port}`);
				expect(init?.redirect).toBe("manual");
				body = String(init?.body ?? "");
				return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 60 });
			});
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: "https://provider.example/authorize",
					tokenUrl: `http://token.example:${port}/token`,
					clientId: "client-id",
					clientSecret: "client-secret",
				},
				{},
			);
			const credentials = await flow.exchangeToken(
				"authorization-code",
				"state",
				"https://client.example/oauth/callback",
			);
			expect(credentials).toMatchObject({ access: "access-token", refresh: "refresh-token" });
			expect(new URLSearchParams(body).get("code")).toBe("authorization-code");
			expect(new URLSearchParams(body).get("client_secret")).toBe("client-secret");
			expect(hits).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	it("fails a redirected token exchange instead of returning tokens", async () => {
		let followed = 0;
		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.pathname === "/token") {
				expect(init?.redirect).toBe("manual");
				expect(String(init?.body ?? "")).toContain("client_secret=client-secret");
				return new Response("go", { status: 302, headers: { Location: "http://127.0.0.1/steal" } });
			}
			followed += 1;
			return Response.json({ access_token: "stolen", refresh_token: "stolen", expires_in: 60 });
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://token.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
			},
			{},
		);
		await expect(
			flow.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback"),
		).rejects.toThrow(/Refusing non-public OAuth endpoint/);
		expect(followed).toBe(0);
	});

	it("does not fetch registration metadata from a private address after a public lookup", async () => {
		const { server, hits, port } = listenForPrivateHits();
		const wire: string[] = [];
		try {
			mockLookup((hostname, lookupIndex) =>
				hostname === "auth.example" && lookupIndex >= 2 ? "127.0.0.1" : "8.8.8.8",
			);
			using _hook = hookFetch((input, init, next) => {
				const href = String(input);
				wire.push(href);
				if (new URL(href).hostname === "127.0.0.1") return next(input, init);
				return Response.json({
					registration_endpoint: `http://auth.example:${port}/register`,
					client_id: "should-not-register",
				});
			});
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: `http://auth.example:${port}/authorize`,
					tokenUrl: "https://provider.example/token",
				},
				{},
			);
			const { url } = await flow.generateAuthUrl("state", "https://client.example/oauth/callback");
			expect(flow.resolvedClientId).toBeUndefined();
			expect(new URL(url).searchParams.get("client_id")).toBeNull();
			expect(hits).toEqual([]);
			expect(wire.some(href => new URL(href).hostname === "127.0.0.1")).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("does not post dynamic registration to a private address after metadata was public", async () => {
		const { server, hits, port } = listenForPrivateHits();
		try {
			mockLookup((hostname, lookupIndex) =>
				hostname === "register.example" && lookupIndex >= 2 ? "127.0.0.1" : "8.8.8.8",
			);
			using _hook = hookFetch((input, _init, next) => {
				const href = String(input);
				if (new URL(href).hostname === "127.0.0.1") return next(input, _init);
				const url = observedUrl(input, _init);
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return Response.json({ registration_endpoint: `http://register.example:${port}/register` });
				}
				if (url.pathname === "/register") {
					return Response.json({ client_id: "should-not-register", client_secret: "should-not-keep" });
				}
				return new Response("ok", { status: 200 });
			});
			const flow = new MCPOAuthFlow(
				{
					authorizationUrl: "https://auth.example/authorize",
					tokenUrl: "https://provider.example/token",
				},
				{},
			);
			const { url } = await flow.generateAuthUrl("state", "https://client.example/oauth/callback");
			expect(flow.resolvedClientId).toBeUndefined();
			expect(flow.registeredClientSecret).toBeUndefined();
			expect(new URL(url).searchParams.get("client_id")).toBeNull();
			expect(hits).toEqual([]);
		} finally {
			server.stop(true);
		}
	});

	it("ignores a metadata redirect and still returns the authorization URL", async () => {
		let followed = 0;
		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.pathname === "/authorize") return new Response("ok", { status: 200 });
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				expect(init?.redirect).toBe("manual");
				return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/register" } });
			}
			followed += 1;
			return Response.json({ client_id: "redirected-client", registration_endpoint: "http://127.0.0.1/register" });
		});
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: "https://auth.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		const { url } = await flow.generateAuthUrl("state", "https://client.example/oauth/callback");
		expect(flow.resolvedClientId).toBeUndefined();
		expect(new URL(url).pathname).toBe("/authorize");
		expect(followed).toBe(0);
	});

	const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;

	async function withProxyEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
		const previous = new Map<string, string | undefined>();
		for (const key of PROXY_ENV_KEYS) {
			previous.set(key, process.env[key]);
			const next = values[key];
			if (next === undefined) delete process.env[key];
			else process.env[key] = next;
		}
		try {
			await run();
		} finally {
			for (const key of PROXY_ENV_KEYS) {
				const prior = previous.get(key);
				// Bun keeps a proxy it already read when the key is only deleted; blank
				// it first so later test files in the same process dial directly.
				process.env[key] = "";
				if (prior === undefined) delete process.env[key];
				else process.env[key] = prior;
			}
		}
	}

	function onlyProxy(key: (typeof PROXY_ENV_KEYS)[number]): Record<string, string | undefined> {
		const values: Record<string, string | undefined> = {};
		for (const name of PROXY_ENV_KEYS) values[name] = name === key ? "http://127.0.0.1:9" : undefined;
		return values;
	}

	async function expectPublicExchangeAndRegistration(): Promise<void> {
		let registered = false;
		let tokenCalls = 0;
		using _hook = hookFetch((input, init) => {
			const url = observedUrl(input, init);
			if (url.origin === "https://provider.example" && url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({ registration_endpoint: "https://provider.example/register" });
			}
			if (url.origin === "https://provider.example" && url.pathname === "/register") {
				registered = true;
				return Response.json({ client_id: "registered-client", client_secret: "registered-secret" });
			}
			if (url.origin === "https://provider.example" && url.pathname === "/authorize") {
				return new Response("ok", { status: 200 });
			}
			if (url.origin === "https://provider.example" && url.pathname === "/token") {
				tokenCalls += 1;
				expect(new URLSearchParams(String(init?.body ?? "")).get("client_secret")).toBe("client-secret");
				return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 60 });
			}
			throw new Error(`Unexpected fetch: ${url.href}`);
		});
		const registration = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
			},
			{},
		);
		const auth = await registration.generateAuthUrl("state", "https://client.example/oauth/callback");
		expect(new URL(auth.url).searchParams.get("client_id")).toBe("registered-client");
		expect(registration.resolvedClientId).toBe("registered-client");
		expect(registered).toBe(true);

		const token = new MCPOAuthFlow(
			{
				authorizationUrl: "https://provider.example/authorize",
				tokenUrl: "https://provider.example/token",
				clientId: "client-id",
				clientSecret: "client-secret",
			},
			{},
		);
		const credentials = await token.exchangeToken(
			"authorization-code",
			"state",
			"https://client.example/oauth/callback",
		);
		expect(credentials.access).toBe("access-token");
		expect(tokenCalls).toBe(1);
	}

	for (const key of PROXY_ENV_KEYS) {
		it(`refuses the authorization-code exchange and skips registration when ${key} is set`, async () => {
			let fetches = 0;
			using _hook = hookFetch(() => {
				fetches += 1;
				return Response.json({ access_token: "should-not-issue", client_id: "should-not-register" });
			});
			await withProxyEnv(onlyProxy(key), async () => {
				const token = new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						tokenUrl: "https://provider.example/token",
						clientId: "client-id",
						clientSecret: "client-secret",
					},
					{},
				);
				await expect(
					token.exchangeToken("authorization-code", "state", "https://client.example/oauth/callback"),
				).rejects.toThrow(/Refusing non-public OAuth endpoint: proxy/);
				const registration = new MCPOAuthFlow(
					{
						authorizationUrl: "https://provider.example/authorize",
						tokenUrl: "https://provider.example/token",
					},
					{},
				);
				const auth = await registration.generateAuthUrl("state", "https://client.example/oauth/callback");
				expect(registration.resolvedClientId).toBeUndefined();
				expect(registration.registeredClientSecret).toBeUndefined();
				expect(new URL(auth.url).searchParams.get("client_id")).toBeNull();
			});
			expect(fetches).toBe(0);
		});
	}

	it("exchanges and registers when no proxy variable is set", async () => {
		const values: Record<string, string | undefined> = {};
		for (const key of PROXY_ENV_KEYS) values[key] = undefined;
		await withProxyEnv(values, () => expectPublicExchangeAndRegistration());
	});

	it("exchanges and registers when proxy variables are empty", async () => {
		const values: Record<string, string | undefined> = {};
		for (const key of PROXY_ENV_KEYS) values[key] = "";
		await withProxyEnv(values, () => expectPublicExchangeAndRegistration());
	});
});
