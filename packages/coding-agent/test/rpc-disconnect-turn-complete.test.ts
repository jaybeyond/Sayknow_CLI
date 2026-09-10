import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RpcClient } from "@sayknow-cli/coding-agent/modes/rpc/rpc-client";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fixtureModelsYaml = `providers:\n  rpc-test:\n    auth: none\n    api: openai-responses\n    baseUrl: http://127.0.0.1:9/v1\n    models:\n      - id: rpc-test-model\n        contextWindow: 100000\n        maxTokens: 4096\n        cost:\n          input: 0\n          output: 0\n          cacheRead: 0\n          cacheWrite: 0\n`;
/** `--mode rpc --listen` is retired (docs/sdk.md); args.ts rejects it before any socket binds. */
const REMOVAL_MESSAGE = "--mode rpc was removed; external control now uses the Sayknow-CLI SDK (docs/sdk.md)";
let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;
beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-disconnect-"));
	agentDir = path.join(workspace, ".skc", "agent");
	cliEnv = createHarnessCliEnv(repoRoot);
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "models.yml"), fixtureModelsYaml);
	cliEnv.env.SKC_CODING_AGENT_DIR = agentDir;
	cliEnv.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(async () => {
	try {
		cliEnv.cleanup();
	} catch {}
	await rm(workspace, { recursive: true, force: true });
});
function spawnRpc(socketPath: string) {
	return Bun.spawn(
		[
			"bun",
			cliEntry,
			"--mode",
			"rpc",
			"--provider",
			"rpc-test",
			"--model",
			"rpc-test-model",
			"--session-dir",
			path.join(workspace, "sessions"),
			"--listen",
			socketPath,
		],
		{
			cwd: workspace,
			env: { ...cliEnv.env, SKC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

describe("UDS disconnect after turn completion removal boundary", () => {
	test("reconnect has nothing to recover: the launch is refused, RpcClient.start() rejects, and no session state exists", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = spawnRpc(socketPath);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(2);
			expect(stdout).toContain("USAGE");
			expect(stderr).toContain(REMOVAL_MESSAGE);
			await expect(stat(socketPath)).rejects.toThrow();

			// A client that "disconnects" never connected: start() rejects promptly instead
			// of waiting on a ready frame, and the API stays fail-closed afterwards.
			const first = new RpcClient({ transport: "uds", socketPath });
			await expect(first.start()).rejects.toThrow();
			await expect(first.getMessages()).rejects.toThrow("Client not started");
			expect(() => first.stop()).not.toThrow();

			// "Reconnecting" finds the same absence: no server, no messages, no session.
			const second = new RpcClient({ transport: "uds", socketPath });
			await expect(second.start()).rejects.toThrow();
			await expect(second.getState()).rejects.toThrow("Client not started");
			second.stop();
			await expect(stat(path.join(workspace, "sessions"))).rejects.toThrow();
		} finally {
			proc.kill();
		}
	}, 45_000);
});
