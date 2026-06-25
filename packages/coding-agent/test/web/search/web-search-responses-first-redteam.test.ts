import { describe, expect, it } from "bun:test";
import { hookFetch } from "@sayknow-cli/utils";
import type { AuthStorage } from "../../../src/session/auth-storage";
import { OpenAICompatibleSearchProvider } from "../../../src/web/search/providers/openai-compatible";
import type { ActiveSearchModelContext } from "../../../src/web/search/types";

function auth(keys: Record<string, string> = { proxy: "sk-proxy" }): AuthStorage {
	return {
		getApiKey: (provider: string) => keys[provider],
	} as unknown as AuthStorage;
}

const ctx: ActiveSearchModelContext = {
	provider: "proxy",
	modelId: "gpt-redteam",
	api: "openai-completions",
	baseUrl: "https://proxy.example/v1",
	headers: { "X-Trace": "redteam", "X-Client": "skc" },
};

function searchParams(activeModelContext: ActiveSearchModelContext = ctx) {
	return {
		query: "latest grounded result",
		systemPrompt: "Search the web and cite sources.",
		limit: 5,
		authStorage: auth(),
		activeModelContext,
	};
}

function responseWithAnnotation(url = "https://responses.example/source") {
	return {
		id: "resp_ok",
		output: [
			{ type: "web_search_call", status: "completed", action: { type: "search" } },
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "grounded answer",
						annotations: [{ type: "url_citation", url, title: "Responses Source" }],
					},
				],
			},
		],
	};
}

describe("OpenAI-compatible responses-first red-team", () => {
	it("hits /responses first even for an openai-completions context", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			urls.push(String(input));
			return Response.json(responseWithAnnotation());
		});

		const result = await new OpenAICompatibleSearchProvider().search(searchParams());

		expect(urls).toEqual(["https://proxy.example/v1/responses"]);
		expect(result.sources.map(s => s.url)).toEqual(["https://responses.example/source"]);
	});

	it("falls back after 404 from /responses, preserves order, and parses chat annotations", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/responses")) return new Response("missing", { status: 404 });
			expect(url).toBe("https://proxy.example/v1/chat/completions");
			return Response.json({
				id: "chat_404_fallback",
				choices: [
					{
						message: {
							content: "chat fallback answer",
							annotations: [{ type: "url_citation", url: "https://chat.example/404", title: "Chat 404" }],
						},
					},
				],
			});
		});

		const result = await new OpenAICompatibleSearchProvider().search(searchParams());

		expect(urls).toEqual(["https://proxy.example/v1/responses", "https://proxy.example/v1/chat/completions"]);
		expect(result.sources).toEqual([{ title: "Chat 404", url: "https://chat.example/404", snippet: undefined }]);
	});

	it("falls back after 405 from /responses", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/responses")) return new Response("method not allowed", { status: 405 });
			return Response.json({
				id: "chat_405_fallback",
				choices: [
					{
						message: {
							content: "chat fallback answer",
							annotations: [{ type: "url_citation", url: "https://chat.example/405", title: "Chat 405" }],
						},
					},
				],
			});
		});

		const result = await new OpenAICompatibleSearchProvider().search(searchParams());

		expect(urls).toEqual(["https://proxy.example/v1/responses", "https://proxy.example/v1/chat/completions"]);
		expect(result.sources.map(s => s.url)).toEqual(["https://chat.example/405"]);
	});

	it("surfaces non-404/405 /responses errors without falling back", async () => {
		const urls: string[] = [];
		using _hook = hookFetch(async input => {
			urls.push(String(input));
			return new Response("upstream exploded", { status: 500 });
		});

		await expect(new OpenAICompatibleSearchProvider().search(searchParams())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 500,
		});
		expect(urls).toEqual(["https://proxy.example/v1/responses"]);
	});

	it("harvests inline-only response sources only when web_search_call proves search ran", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "resp_inline",
				output: [
					{ type: "web_search_call", status: "completed", action: { type: "search", query: "latest" } },
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "The grounded result is documented at [release notes](https://inline.example/releases).",
							},
						],
					},
				],
			}),
		);

		const result = await new OpenAICompatibleSearchProvider().search(searchParams());

		expect(result.sources.map(s => s.url)).toEqual(["https://inline.example/releases"]);
	});

	it("fails closed with 424 when responses has no search signal but mentions a prose URL", async () => {
		using _hook = hookFetch(async () =>
			Response.json({
				id: "resp_no_signal",
				output_text: "This ordinary model answer mentions https://masked.example/ but search did not run.",
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: "Also see [masked](https://masked.example/docs).",
							},
						],
					},
				],
			}),
		);

		await expect(new OpenAICompatibleSearchProvider().search(searchParams())).rejects.toMatchObject({
			provider: "openai-compatible",
			status: 424,
		});
	});

	it("sends bearer credentials and context headers on both responses and chat fallback POSTs", async () => {
		const seen: Array<{ url: string; method?: string; authorization?: string; trace?: string; client?: string }> = [];
		using _hook = hookFetch(async (input, init) => {
			const headers = init?.headers as Record<string, string>;
			const url = String(input);
			seen.push({
				url,
				method: init?.method,
				authorization: headers.Authorization,
				trace: headers["X-Trace"],
				client: headers["X-Client"],
			});
			if (url.endsWith("/responses")) return new Response("missing", { status: 404 });
			return Response.json({
				id: "chat_headers",
				choices: [
					{
						message: {
							content: "chat fallback answer",
							annotations: [{ type: "url_citation", url: "https://headers.example/", title: "Headers" }],
						},
					},
				],
			});
		});

		await new OpenAICompatibleSearchProvider().search(searchParams());

		expect(seen).toEqual([
			{
				url: "https://proxy.example/v1/responses",
				method: "POST",
				authorization: "Bearer sk-proxy",
				trace: "redteam",
				client: "skc",
			},
			{
				url: "https://proxy.example/v1/chat/completions",
				method: "POST",
				authorization: "Bearer sk-proxy",
				trace: "redteam",
				client: "skc",
			},
		]);
	});
});
