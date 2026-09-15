import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@sayknow-cli/utils";

describe("custom provider auto model discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `skc-auto-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	function mixedGatewayResponse(): Response {
		return new Response(
			JSON.stringify({
				object: "list",
				data: [
					{ id: "gpt-5.6-sol", owned_by: "openai" },
					{ id: "gpt-image-1.5", owned_by: "openai" },
					{ id: "claude-opus-5", owned_by: "anthropic" },
					{ id: "claude-sonnet-4-20250514" },
					{ id: "llama-3-70b", owned_by: "meta" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}

	test("auto-enables /v1/models discovery for a mixed gateway without a discovery block", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				"      - id: gpt-5.6-sol",
				"        api: openai-responses",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		using _hook = hookFetch((input, init) => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			const headers = init?.headers as Headers | Record<string, string> | undefined;
			const authHeader = headers instanceof Headers ? headers.get("Authorization") : headers?.Authorization;
			expect(authHeader).toBe("Bearer sk-withfox");
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		expect(registry.getProviderDiscoveryState("withfox")?.status).toBe("ok");
		const ids = registry
			.getAll()
			.filter(model => model.provider === "withfox")
			.map(model => model.id)
			.sort();
		expect(ids).toContain("gpt-image-1.5");
		expect(ids).toContain("claude-sonnet-4-20250514");
		expect(ids).toContain("llama-3-70b");
	});

	test("auto-classifies the wire api family per discovered model", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    models:",
				"      - id: gpt-5.6-sol",
				"        api: openai-responses",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		expect(registry.find("withfox", "claude-opus-5")?.api).toBe("anthropic-messages");
		expect(registry.find("withfox", "claude-sonnet-4-20250514")?.api).toBe("anthropic-messages");
		expect(registry.find("withfox", "gpt-5.6-sol")?.api).toBe("openai-responses");
		expect(registry.find("withfox", "gpt-image-1.5")?.api).toBe("openai-responses");
		expect(registry.find("withfox", "llama-3-70b")?.api).toBe("openai-responses");
	});

	test("does not auto-enable discovery for an Anthropic-only custom provider", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  anthroxy:",
				"    baseUrl: https://anthroxy.example/v1",
				"    apiKey: sk-anthroxy",
				"    auth: apiKey",
				"    models:",
				"      - id: claude-opus-5",
				"        api: anthropic-messages",
			].join("\n"),
		);

		let modelsListRequested = false;
		using _hook = hookFetch(input => {
			const url = String(input);
			if (url.endsWith("/models")) {
				modelsListRequested = true;
			}
			return new Response(null, { status: 404 });
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("anthroxy");

		expect(modelsListRequested).toBe(false);
		const ids = registry
			.getAll()
			.filter(model => model.provider === "anthroxy")
			.map(model => model.id);
		expect(ids).toEqual(["claude-opus-5"]);
	});

	test("honors an explicit apiByModelPrefix over auto-detection", async () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  withfox:",
				"    baseUrl: http://100.92.25.20:1436/v1",
				"    apiKey: sk-withfox",
				"    auth: apiKey",
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
				"      apiByModelPrefix:",
				"        claude: openai-completions",
				"    models: []",
			].join("\n"),
		);

		using _hook = hookFetch(input => {
			const url = String(input);
			if (url !== "http://100.92.25.20:1436/v1/models") {
				throw new Error(`Unexpected URL: ${url}`);
			}
			return mixedGatewayResponse();
		});

		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refreshProvider("withfox");

		expect(registry.find("withfox", "claude-opus-5")?.api).toBe("openai-completions");
	});
});
