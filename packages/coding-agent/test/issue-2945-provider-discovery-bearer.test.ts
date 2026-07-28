import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@sayknow-cli/coding-agent/config/settings";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { Snowflake } from "@sayknow-cli/utils";

const EXPECTED_KEY = "issue-2945-local-key";
const KEY_ENV = "ISSUE_2945_LLM_API_KEY";

type SeenRequest = { url: string | undefined; authorization: string | undefined };

async function startModelsListServer(options: {
	expectedKey?: string;
	seen: SeenRequest[];
}): Promise<{ server: http.Server; baseUrl: string }> {
	const server = http.createServer((req, res) => {
		options.seen.push({ url: req.url, authorization: req.headers.authorization });
		if (options.expectedKey !== undefined && req.headers.authorization !== `Bearer ${options.expectedKey}`) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "missing or invalid bearer" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "local-model-1" }] }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("server address unavailable");
	return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

describe("issue #2945 provider discovery Bearer auth", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;
	let server: http.Server | undefined;
	const seen: SeenRequest[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = path.join(os.tmpdir(), `skc-test-issue-2945-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		seen.length = 0;
	});

	afterEach(() => {
		resetSettingsForTest();
		authStorage.close();
		server?.close();
		server = undefined;
		delete process.env[KEY_ENV];
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	let baseUrl: string;
	async function waitFor(condition: () => boolean): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (!condition() && Date.now() < deadline) {
			await Bun.sleep(25);
		}
	}

	test("authenticated models-list endpoint receives the resolved apiKeyEnv bearer", async () => {
		process.env[KEY_ENV] = EXPECTED_KEY;
		({ server, baseUrl } = await startModelsListServer({ expectedKey: EXPECTED_KEY, seen }));
		await Bun.write(
			modelsJsonPath,
			`providers:\n  local:\n    baseUrl: ${baseUrl}\n    apiKeyEnv: ${KEY_ENV}\n    api: openai-completions\n    discovery:\n      type: openai-models-list\n    models: []\n`,
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh("online");
		// Wait for the merged end state, not just the HTTP request: discovery
		// merges into the catalog asynchronously after the response arrives.
		await waitFor(() => seen.length > 0 && registry.find("local", "local-model-1") !== undefined);

		expect(seen[0].url).toBe("/v1/models");
		expect(seen[0].authorization).toBe(`Bearer ${EXPECTED_KEY}`);
		expect(registry.find("local", "local-model-1")).toBeDefined();
	});

	test("unauthenticated local-provider discovery sends no Authorization header", async () => {
		({ server, baseUrl } = await startModelsListServer({ seen }));
		await Bun.write(
			modelsJsonPath,
			`providers:\n  local:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    auth: none\n    discovery:\n      type: openai-models-list\n    models: []\n`,
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh("online");
		await waitFor(() => seen.length > 0 && registry.find("local", "local-model-1") !== undefined);

		expect(seen[0].authorization).toBeUndefined();
		expect(registry.find("local", "local-model-1")).toBeDefined();
	});

	test("rejected credentials surface a useful redacted error", async () => {
		process.env[KEY_ENV] = "wrong-key";
		({ server, baseUrl } = await startModelsListServer({ expectedKey: EXPECTED_KEY, seen }));
		await Bun.write(
			modelsJsonPath,
			`providers:\n  local:\n    baseUrl: ${baseUrl}\n    apiKeyEnv: ${KEY_ENV}\n    api: openai-completions\n    discovery:\n      type: openai-models-list\n    models: []\n`,
		);

		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		await registry.refresh("online");
		await waitFor(() => seen.length > 0 && registry.getProviderDiscoveryState("local")?.status === "unavailable");

		expect(seen[0].authorization).toBe("Bearer wrong-key");
		expect(registry.find("local", "local-model-1")).toBeUndefined();

		const status = registry.getProviderDiscoveryState("local");
		expect(status?.status).toBe("unavailable");
		expect(status?.error).toBeDefined();
		expect(status?.error).toContain("HTTP 401");
		expect(status?.error).toContain("local");
		// Redaction: the error must never carry key material.
		expect(status?.error).not.toContain("wrong-key");
		expect(status?.error).not.toContain(EXPECTED_KEY);
	});
});
