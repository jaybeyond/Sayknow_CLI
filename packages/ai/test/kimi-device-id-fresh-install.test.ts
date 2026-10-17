import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@sayknow-cli/utils";
import type { FetchImpl } from "../src/types";
import { refreshKimiToken } from "../src/utils/oauth/kimi";

describe("Kimi device id on a fresh install", () => {
	const originalAgentDir = getAgentDir();
	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	it("creates the missing agent dir instead of failing the token refresh before any request", async () => {
		const root = TempDir.createSync("@skc-kimi-fresh-");
		const agentDir = path.join(root.path(), "never-created", "agent");
		setAgentDir(agentDir);
		const calls: string[] = [];
		const fetchStub = (async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt2", expires_in: 3600 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as FetchImpl;

		const creds = await refreshKimiToken("rt", { fetch: fetchStub });

		expect(calls).toHaveLength(1);
		expect(creds.access).toBe("at");
		const deviceId = fs.readFileSync(path.join(agentDir, "kimi-device-id"), "utf-8").trim();
		expect(deviceId).toMatch(/^[0-9a-f]{32}$/);
		root.removeSync();
	});
});
