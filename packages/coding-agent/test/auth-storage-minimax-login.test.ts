import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { hookFetch, Snowflake } from "@sayknow-cli/utils";

describe("AuthStorage MiniMax login", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let currentApiKey = "sk-old";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-minimax-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true });
		}
	});

	test("keeps the first MiniMax Coding Plan API key and adds the relogin key to the pool", async () => {
		using _hook = hookFetch(
			() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
		);

		const loginCallbacks = {
			onAuth: () => {},
			onPrompt: async () => currentApiKey,
		};

		await authStorage.login("minimax-code", loginCallbacks);
		currentApiKey = "sk-new";
		await authStorage.login("minimax-code", loginCallbacks);

		// API-key login upserts instead of replacing the provider pool, so a second
		// account is added rather than wiping the first. The first row stays the
		// provider's primary credential.
		expect(authStorage.get("minimax-code")).toEqual({
			type: "api_key",
			key: "sk-old",
		});
		expect(authStorage.getAll()["minimax-code"]).toEqual([
			{ type: "api_key", key: "sk-old" },
			{ type: "api_key", key: "sk-new" },
		]);
	});
});
