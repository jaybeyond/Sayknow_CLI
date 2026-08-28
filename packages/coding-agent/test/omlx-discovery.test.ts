import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UNK_CONTEXT_WINDOW, UNK_MAX_TOKENS } from "@sayknow-cli/ai";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@sayknow-cli/utils";

describe("ModelRegistry oMLX discovery", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `skc-omlx-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("preserves oMLX limits and thinking capabilities", async () => {
		using _hook = hookFetch(input => {
			if (String(input) !== "http://127.0.0.1:8080/v1/models") return new Response(null, { status: 404 });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "Qwen3.5-122B", max_model_len: 262144, max_tokens: 8192 },
						{ id: "fractional", max_model_len: 1.5 },
						{ id: "string-limit", max_model_len: "131072" },
						{ id: "unsafe-limit", max_model_len: Number.MAX_SAFE_INTEGER + 1 },
						{ id: "fractional-alias", context_length: 1.5, max_tokens: 1.5 },
						{ id: "string-alias", context_window: "131072", max_output_tokens: "8192" },
						{
							id: "unsafe-alias",
							max_context_length: Number.MAX_SAFE_INTEGER + 1,
							max_completion_tokens: Number.MAX_SAFE_INTEGER + 1,
						},
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		await registry.refresh();

		expect(registry.find("omlx", "Qwen3.5-122B")).toMatchObject({
			contextWindow: 262144,
			maxTokens: 8192,
			reasoning: true,
			thinking: { mode: "effort", minLevel: "low", maxLevel: "high", defaultLevel: "medium" },
			compat: { supportsReasoningEffort: true, thinkingFormat: "qwen-chat-template" },
		});
		expect(registry.find("omlx", "fractional")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("omlx", "string-limit")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("omlx", "unsafe-limit")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		for (const id of ["fractional-alias", "string-alias", "unsafe-alias"]) {
			expect(registry.find("omlx", id)?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
			expect(registry.find("omlx", id)?.maxTokens).toBe(UNK_MAX_TOKENS);
		}
	});

	test("applies safe integer limits to explicitly configured oMLX discovery", async () => {
		const modelsPath = path.join(tempDir, "configured-models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					omlx: {
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:19002/v1",
						auth: "none",
						discovery: { type: "omlx" },
					},
				},
			}),
		);
		using _hook = hookFetch(input => {
			if (String(input) !== "http://127.0.0.1:19002/v1/models") return new Response(null, { status: 404 });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "valid-configured", context_length: 65536, max_output_tokens: 4096 },
						{ id: "invalid-configured", context_length: 1.5, max_output_tokens: Number.MAX_SAFE_INTEGER + 1 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refresh();

		expect(registry.find("omlx", "valid-configured")).toMatchObject({
			contextWindow: 65536,
			maxTokens: 4096,
		});
		expect(registry.find("omlx", "invalid-configured")?.contextWindow).toBe(UNK_CONTEXT_WINDOW);
		expect(registry.find("omlx", "invalid-configured")?.maxTokens).toBe(UNK_MAX_TOKENS);
	});
});
