import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
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
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-steal-"));
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
async function collect(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}
function connect(socketPath: string) {
	return Bun.connect({ unix: socketPath, socket: { data() {}, open() {}, error() {}, close() {} } });
}

describe("UDS controller stealing removal boundary", () => {
	test("no controller ever comes up: launches on the same socket path are refused before binding", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const first = await collect(spawnRpc(socketPath));
		expect(first.exitCode, first.stderr).toBe(2);
		expect(first.stdout).toContain("USAGE");
		expect(first.stderr).toContain(REMOVAL_MESSAGE);
		await expect(stat(socketPath)).rejects.toThrow();
		await expect(connect(socketPath)).rejects.toThrow();

		// A would-be stealing client launches against the same path and is refused the
		// same way: there is no live socket to contend for, so no duplicate-socket guard
		// and no controller handover ever happens.
		const second = await collect(spawnRpc(socketPath));
		expect(second.exitCode, second.stderr).toBe(2);
		expect(second.stdout).toContain("USAGE");
		expect(second.stderr.trim()).toBe(REMOVAL_MESSAGE);
		expect(second.stderr.trim()).toBe(first.stderr.trim());
		await expect(stat(socketPath)).rejects.toThrow();
		await expect(connect(socketPath)).rejects.toThrow();
		await expect(stat(path.join(workspace, "sessions"))).rejects.toThrow();
	}, 45_000);
});
