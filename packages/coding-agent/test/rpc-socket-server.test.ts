import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createHarnessCliEnv, type HarnessCliEnv } from "./harness-control-plane/cli-workspace-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const fixtureModelsYaml = `providers:
  rpc-test:
    auth: none
    api: openai-responses
    baseUrl: http://127.0.0.1:9/v1
    models:
      - id: rpc-test-model
        contextWindow: 100000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;

const defaultSelectionModelsYaml = `providers:
  rpc-test:
    auth: none
    api: openai-responses
    baseUrl: http://127.0.0.1:9/v1
    models:
      - id: rpc-test-a
        contextWindow: 100000
        maxTokens: 4096
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      - id: rpc-test-b
        contextWindow: 100000
        maxTokens: 4096
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      - id: rpc-test-c
        contextWindow: 100000
        maxTokens: 4096
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
`;

/**
 * `--mode rpc --listen` was retired with the rest of RPC mode (docs/sdk.md);
 * src/cli/args.ts rejects it as a usage error before a Unix socket server can
 * bind. These probes pin the UDS side of that removal boundary.
 */
const REMOVAL_MESSAGE = "--mode rpc was removed; external control now uses the Sayknow-CLI SDK (docs/sdk.md)";

interface RefusedLaunch {
	exitCode: number;
	stdout: string;
	stderr: string;
}

let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-sock-ws-"));
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
	} catch {
		// best-effort
	}
	await rm(workspace, { recursive: true, force: true });
});

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readBytesIfPresent(filePath: string): Promise<Uint8Array | undefined> {
	const file = Bun.file(filePath);
	return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
}

function hasJsonFrame(raw: string): boolean {
	return raw.split("\n").some(line => {
		const text = line.trim();
		if (!text.startsWith("{")) return false;
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	});
}

function spawnRemovedListen(socketPath: string, sessionDir: string, model = "rpc-test-model") {
	return Bun.spawn(
		[
			"bun",
			cliEntry,
			"--mode",
			"rpc",
			"--provider",
			"rpc-test",
			"--model",
			model,
			"--session-dir",
			sessionDir,
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

async function collect(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<RefusedLaunch> {
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function expectUsageRefusal(result: RefusedLaunch): void {
	expect(result.exitCode, result.stderr).toBe(2);
	expect(result.stdout).toContain("USAGE");
	expect(hasJsonFrame(result.stdout)).toBe(false);
	expect(result.stderr).toContain(REMOVAL_MESSAGE);
	expect(result.stderr).toContain("docs/sdk.md");
}

describe("skc --mode rpc --listen (UDS persistent server) removal boundary", () => {
	it("fails closed before binding the socket and points callers to the SDK", async () => {
		await writeFile(path.join(agentDir, "models.yml"), defaultSelectionModelsYaml);
		const socketPath = path.join(workspace, "rpc-default-selection.sock");
		const sessionDir = path.join(workspace, "default-selection-sessions");
		const proc = spawnRemovedListen(socketPath, sessionDir, "rpc-test-a");
		try {
			expectUsageRefusal(await collect(proc));
			await expect(stat(socketPath)).rejects.toThrow();
			expect(await exists(sessionDir)).toBe(false);
		} finally {
			proc.kill();
		}
	}, 45_000);

	it("does not mutate durable default-selection bytes or create session state", async () => {
		const configFile = path.join(agentDir, "config.yml");
		const modelsFile = path.join(agentDir, "models.yml");
		await writeFile(configFile, "modelRoles:\n  default: rpc-test/rpc-test-model:off\n");
		const configBaseline = await readBytesIfPresent(configFile);
		const modelsBaseline = await readBytesIfPresent(modelsFile);
		const socketPath = path.join(workspace, "rpc-malformed.sock");
		const sessionDir = path.join(workspace, "sessions-malformed");
		const proc = spawnRemovedListen(socketPath, sessionDir);
		try {
			expectUsageRefusal(await collect(proc));
			expect(await readBytesIfPresent(configFile)).toEqual(configBaseline);
			expect(await readBytesIfPresent(modelsFile)).toEqual(modelsBaseline);
			expect(await exists(sessionDir)).toBe(false);
			expect(await Bun.file(socketPath).exists()).toBe(false);
		} finally {
			proc.kill();
		}
	}, 45_000);

	it("leaves no server alive to reconnect to, and a relaunch on the same path is refused identically", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const sessionDir = path.join(workspace, "sessions");
		const first = await collect(spawnRemovedListen(socketPath, sessionDir));
		expectUsageRefusal(first);
		await expect(
			Bun.connect({ unix: socketPath, socket: { data() {}, open() {}, error() {}, close() {} } }),
		).rejects.toThrow();

		// The path was never bound, so the second launch hits the same usage error rather
		// than the live-socket duplicate refusal a real server would raise.
		const second = await collect(spawnRemovedListen(socketPath, sessionDir));
		expectUsageRefusal(second);
		expect(second.stderr.trim()).toBe(REMOVAL_MESSAGE);
		expect(second.stderr.trim()).toBe(first.stderr.trim());
		await expect(stat(socketPath)).rejects.toThrow();
	}, 45_000);

	it("registers no discoverable socket record", async () => {
		const socketPath = path.join(workspace, "rpc2.sock");
		const proc = spawnRemovedListen(socketPath, path.join(workspace, "sessions2"));
		try {
			expectUsageRefusal(await collect(proc));
			const { listRpcSessions } = await import("@sayknow-cli/coding-agent/modes/shared/agent-wire/session-registry");
			const sessions = await listRpcSessions(agentDir);
			expect(sessions.find(s => s.transport === "socket")).toBeUndefined();
			expect(sessions.find(s => s.endpoint === socketPath)).toBeUndefined();
		} finally {
			proc.kill();
		}
	}, 45_000);
});
