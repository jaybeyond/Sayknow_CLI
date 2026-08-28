import { describe, expect, it } from "bun:test";
import { loginSglang } from "../src/utils/oauth/sglang";

describe("SGLang login", () => {
	it("stores a trimmed explicit API key without probing the server", async () => {
		let authUrl: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;
		let allowEmpty: boolean | undefined;
		let fetchCalls = 0;

		const apiKey = await loginSglang({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				allowEmpty = prompt.allowEmpty;
				return "  sglang-key  ";
			},
			fetch: (async () => {
				fetchCalls++;
				return new Response();
			}) as unknown as typeof fetch,
		});

		expect(authUrl).toBe("https://docs.sglang.io/docs/advanced_features/server_arguments.html");
		expect(promptMessage).toBe("Paste your SGLang API key");
		expect(promptPlaceholder).toBe("SGLang API key");
		expect(allowEmpty).toBe(false);
		expect(apiKey).toBe("sglang-key");
		expect(fetchCalls).toBe(0);
	});

	it("rejects empty input instead of persisting a no-auth sentinel", async () => {
		await expect(loginSglang({ onPrompt: async () => "   " })).rejects.toThrow("SGLang API key is required");
	});

	it("requires an interactive prompt", async () => {
		await expect(loginSglang({})).rejects.toThrow("sglang login requires onPrompt callback");
	});

	it("honors cancellation after prompting", async () => {
		const controller = new AbortController();
		await expect(
			loginSglang({
				signal: controller.signal,
				onPrompt: async () => {
					controller.abort();
					return "sglang-key";
				},
			}),
		).rejects.toThrow("Login cancelled");
	});
});
