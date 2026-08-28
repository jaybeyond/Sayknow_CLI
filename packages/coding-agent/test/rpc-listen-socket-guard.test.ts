import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isUnixSocketAlive, RpcListenRefusedError } from "@sayknow-cli/coding-agent/modes/rpc/rpc-mode";
import { prepareRpcSocketPath } from "@sayknow-cli/coding-agent/modes/rpc/rpc-socket-security";
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

function spawnRpcSocketServer(socketPath: string) {
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
			path.join(dir, "sessions"),
			"--listen",
			socketPath,
		],
		{
			cwd: dir,
			env: { ...cliEnv.env, SKC_HARNESS_STATE_ROOT: dir, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}
let dir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "rpc-listen-guard-"));
	cliEnv = createHarnessCliEnv(repoRoot);
	const agentDir = path.join(dir, ".skc", "agent");
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "models.yml"), fixtureModelsYaml);
	cliEnv.env.SKC_CODING_AGENT_DIR = agentDir;
	cliEnv.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	cliEnv.cleanup();
	await rm(dir, { recursive: true, force: true });
});

describe("isUnixSocketAlive (--listen live-owner probe, #606)", () => {
	const originalConnect = Bun.connect;

	afterEach(() => {
		Bun.connect = originalConnect;
	});

	it("returns false for a socket path that does not exist", async () => {
		expect(await isUnixSocketAlive(path.join(dir, "missing.sock"))).toBe(false);
	});

	it("returns false for a non-socket file at the path", async () => {
		const filePath = path.join(dir, "not-a-socket");
		await Bun.write(filePath, "stale");
		expect(await isUnixSocketAlive(filePath)).toBe(false);
	});

	it("returns true while a live server is listening, false after it stops", async () => {
		const socketPath = path.join(dir, "live.sock");
		const server = Bun.listen({
			unix: socketPath,
			socket: { data() {}, open() {}, error() {}, close() {} },
		});

		expect(await isUnixSocketAlive(socketPath)).toBe(true);

		server.stop(true);
		expect(await isUnixSocketAlive(socketPath)).toBe(false);
	});

	it("returns false only for known stale/missing connect error codes", async () => {
		for (const code of ["ENOENT", "ECONNREFUSED"]) {
			Bun.connect = mock(async () => {
				const error = new Error(code) as Error & { code: string };
				error.code = code;
				throw error;
			}) as typeof Bun.connect;

			expect(await isUnixSocketAlive(path.join(dir, `${code}.sock`))).toBe(false);
		}
	});

	it("fails closed for unexpected connect error codes", async () => {
		Bun.connect = mock(async () => {
			const error = new Error("permission denied") as Error & { code: string };
			error.code = "EACCES";
			throw error;
		}) as typeof Bun.connect;

		expect(await isUnixSocketAlive(path.join(dir, "permission.sock"))).toBe(true);
	});
});

describe("--listen duplicate refusal boundary (issue 19)", () => {
	it("prepareRpcSocketPath throws the RpcListenRefusedError class main.ts catches at launch", async () => {
		// main.ts imports RpcListenRefusedError from rpc-mode and only exits cleanly
		// for that class; the refusal thrown on a live socket must be that instance.
		const socketPath = path.join(dir, "duplicate.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		try {
			await chmod(socketPath, 0o600);
			await expect(prepareRpcSocketPath(socketPath)).rejects.toBeInstanceOf(RpcListenRefusedError);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

describe("--mode rpc removal boundary", () => {
	it("fails before binding --listen and points callers to the SDK", async () => {
		const socketPath = path.join(dir, "removed-mode.sock");
		const proc = spawnRpcSocketServer(socketPath);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(2);
		expect(stdout).toContain("USAGE");
		expect(stderr).toContain("--mode rpc was removed");
		expect(stderr).toContain("docs/sdk.md");
		await expect(stat(socketPath)).rejects.toThrow();
	});
});
