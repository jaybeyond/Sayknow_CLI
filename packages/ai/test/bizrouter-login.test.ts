import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginBizRouter } from "../src/utils/oauth/bizrouter";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("bizrouter login", () => {
	it("opens BizRouter key settings and validates against models endpoint", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.bizrouter.ai/v1/models");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual({ Authorization: "Bearer sk-br-v1-test" });
			return new Response(JSON.stringify({ models: [], exchange_rate: 1531 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const apiKey = await loginBizRouter({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "sk-br-v1-test";
			},
		});

		expect(authUrl).toBe("https://bizrouter.ai/settings/keys");
		expect(authInstructions).toContain("Create or copy your BizRouter API key");
		expect(promptMessage).toBe("Paste your BizRouter API key");
		expect(promptPlaceholder).toBe("sk-br-v1-...");
		expect(apiKey).toBe("sk-br-v1-test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects empty keys", async () => {
		await expect(
			loginBizRouter({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginBizRouter({})).rejects.toThrow("BizRouter login requires onPrompt callback");
	});

	it("surfaces models endpoint validation errors", async () => {
		global.fetch = vi.fn(
			async () => new Response('{"error":"invalid_api_key"}', { status: 401 }),
		) as unknown as typeof fetch;

		await expect(
			loginBizRouter({
				onPrompt: async () => "sk-br-v1-test",
			}),
		).rejects.toThrow("BizRouter API key validation failed (401)");
	});
});
