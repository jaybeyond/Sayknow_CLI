import { describe, expect, it } from "bun:test";
import { hookFetch } from "@sayknow-cli/utils";
import { omlxModelManagerOptions, sglangModelManagerOptions } from "../src/provider-models/openai-compat";
import { fetchOpenAICompatibleModels, resolveLoopbackOpenAIBaseUrl } from "../src/utils/discovery/openai-compatible";

const fallback = "http://127.0.0.1:30000/v1";

describe("OpenAI-compatible loopback discovery", () => {
	it.each([
		"http://localhost:30000/v1",
		"http://127.0.0.1:30000/v1",
		"https://127.255.1.2:30000/v1",
		"http://[::1]:30000/v1",
		"http://[0:0:0:0:0:0:0:1]:30000/v1",
		"http://[::ffff:127.0.0.1]:30000/v1",
	])("accepts normalized loopback origin %s", candidate => {
		expect(resolveLoopbackOpenAIBaseUrl(candidate, fallback)).toBe(candidate);
	});

	it.each([
		"http://0.0.0.0:30000/v1",
		"http://192.168.1.10:30000/v1",
		"http://example.com:30000/v1",
		"file:///tmp/sglang",
		"not a URL",
		"http://[::ffff:192.168.1.10]:30000/v1",
		"http://127.0.0.1:30000/v1?redirect=https://example.com",
		"http://127.0.0.1:30000/v1#fragment",
		"http://token@127.0.0.1:30000/v1",
	])("rejects non-loopback or non-HTTP origin %s", candidate => {
		expect(resolveLoopbackOpenAIBaseUrl(candidate, fallback)).toBe(fallback);
	});

	it("uses the fallback when no override is present", () => {
		expect(resolveLoopbackOpenAIBaseUrl(undefined, fallback)).toBe(fallback);
		expect(resolveLoopbackOpenAIBaseUrl("   ", fallback)).toBe(fallback);
	});

	it("rejects oversized and malformed catalogs without partial models", async () => {
		const oversized = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "sglang",
			baseUrl: fallback,
			fetch: (async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-length": "1000001", "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		expect(oversized).toBeNull();

		const malformed = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "sglang",
			baseUrl: fallback,
			fetch: (async () =>
				new Response('{"data":"not-an-array"}', {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		expect(malformed).toBeNull();
	});

	it("deduplicates model ids deterministically", async () => {
		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "sglang",
			baseUrl: fallback,
			fetch: (async () =>
				new Response('{"data":[{"id":"z"},{"id":"a"},{"id":"z","name":"latest"}]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		expect(models?.map(model => model.id)).toEqual(["a", "z"]);
		expect(models?.[1]?.name).toBe("latest");
	});

	it("keeps implicit oMLX on loopback and blocks redirects", async () => {
		const requests: Array<{ url: string; redirect: RequestInit["redirect"]; authorization: string | null }> = [];
		using _hook = hookFetch((input, init) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				redirect: init?.redirect,
				authorization: headers.get("authorization"),
			});
			return new Response('{"data":[{"id":"local"}]}', {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const options = omlxModelManagerOptions({ baseUrl: "https://untrusted.example/v1", apiKey: "secret" });
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["local"]);
		expect(requests).toEqual([
			{
				url: "http://127.0.0.1:8080/v1/models",
				redirect: "error",
				authorization: "Bearer secret",
			},
		]);
	});

	it("requires credentials for an explicit remote SGLang endpoint", () => {
		expect(sglangModelManagerOptions({ baseUrl: "https://gpu.example/v1" }).fetchDynamicModels).toBeUndefined();
		expect(
			sglangModelManagerOptions({ baseUrl: "https://gpu.example/v1", apiKey: "secret" }).fetchDynamicModels,
		).toBeFunction();
		expect(
			sglangModelManagerOptions({ baseUrl: "https://user:password@gpu.example/v1", apiKey: "secret" })
				.fetchDynamicModels,
		).toBeUndefined();
		expect(
			sglangModelManagerOptions({ baseUrl: "https://gpu.example/v1?target=other", apiKey: "secret" })
				.fetchDynamicModels,
		).toBeUndefined();
		expect(
			sglangModelManagerOptions({ baseUrl: "https://gpu.example/v1#fragment", apiKey: "secret" }).fetchDynamicModels,
		).toBeUndefined();
	});
});
