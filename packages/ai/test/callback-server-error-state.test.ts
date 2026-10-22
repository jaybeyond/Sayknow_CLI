import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "../src/utils/oauth/callback-server";
import type { OAuthCredentials } from "../src/utils/oauth/types";

const EXPECTED_STATE = "expected-state";

class TestCallbackFlow extends OAuthCallbackFlow {
	constructor(port: number) {
		const authUrl = Promise.withResolvers<string>();
		super(
			{ onAuth: ({ url }) => authUrl.resolve(url) },
			{ preferredPort: port, callbackHostname: "127.0.0.1", callbackBindHostname: "127.0.0.1" },
		);
		this.authUrl = authUrl.promise;
	}

	readonly authUrl: Promise<string>;

	override generateState(): string {
		return EXPECTED_STATE;
	}

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string }> {
		return { url: redirectUri };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "refresh-token", expires: 1 };
	}
}

async function availablePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Bun did not assign a loopback port");
	return port;
}

describe("OAuthCallbackFlow error callbacks", () => {
	it("does not cancel an in-flight login when an error callback has the wrong state", async () => {
		const flow = new TestCallbackFlow(await availablePort());
		let settled = false;
		const login = flow.login().then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const callbackUrl = new URL(await flow.authUrl);
		callbackUrl.search = new URLSearchParams({
			error: "access_denied",
			error_description: "attacker-controlled detail",
			state: "wrong-state",
		}).toString();
		const response = await fetch(callbackUrl);
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("State mismatch");
		expect(settled).toBe(false);

		const correlated = new URL(callbackUrl);
		correlated.search = new URLSearchParams({
			error: "access_denied",
			error_description: "the user denied access",
			state: EXPECTED_STATE,
		}).toString();
		const correlatedResponse = await fetch(correlated);
		expect(correlatedResponse.status).toBe(500);
		await login;
		expect(settled).toBe(true);
	});
});
