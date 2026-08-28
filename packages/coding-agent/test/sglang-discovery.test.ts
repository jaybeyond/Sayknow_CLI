import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@sayknow-cli/utils";

describe("ModelRegistry SGLang discovery", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `skc-sglang-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("discovers the implicit loopback server", async () => {
		using _hook = hookFetch(input => {
			if (String(input) !== "http://127.0.0.1:30000/v1/models") return new Response(null, { status: 404 });
			return new Response(JSON.stringify({ data: [{ id: "sglang-local", max_model_len: 131072 }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"));
		await registry.refresh();

		expect(registry.find("sglang", "sglang-local")).toMatchObject({
			baseUrl: "http://127.0.0.1:30000/v1",
			contextWindow: 131072,
		});
	});

	test("ignores the deprecated local sentinel during credential selection", async () => {
		await authStorage.set("sglang", [
			{ type: "api_key", key: "sglang-local" },
			{ type: "api_key", key: "real-sglang-key" },
		]);
		expect(await authStorage.peekApiKey("sglang")).toBe("real-sglang-key");
		expect(await authStorage.getApiKey("sglang")).toBe("real-sglang-key");

		await authStorage.set("sglang", [{ type: "api_key", key: "sglang-local" }]);
		expect(await authStorage.peekApiKey("sglang")).toBeUndefined();
		expect(await authStorage.getApiKey("sglang")).toBeUndefined();
	});
});
