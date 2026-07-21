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

type Frame = { type?: string; id?: string; success?: boolean; command?: string };

interface SocketClient {
	send(frame: object): void;
	nextFrame(timeoutMs?: number): Promise<Frame>;
	close(): void;
}

async function connectRpcSocket(socketPath: string): Promise<SocketClient> {
	const frames: Frame[] = [];
	const waiters: Array<(frame: Frame) => void> = [];
	const decoder = new TextDecoder();
	let buffer = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket, bytes) {
				buffer += decoder.decode(bytes);
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					const frame = JSON.parse(line) as Frame;
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else frames.push(frame);
				}
			},
		},
	});
	return {
		send(frame: object): void {
			socket.write(`${JSON.stringify(frame)}\n`);
		},
		nextFrame(timeoutMs = 10_000): Promise<Frame> {
			const queued = frames.shift();
			if (queued) return Promise.resolve(queued);
			let timer: ReturnType<typeof setTimeout> | undefined;
			return new Promise<Frame>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Timed out waiting for RPC socket frame")), timeoutMs);
				waiters.push(frame => {
					if (timer) clearTimeout(timer);
					resolve(frame);
				});
			});
		},
		close(): void {
			socket.end();
		},
	};
}

async function waitForSocket(socketPath: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			await stat(socketPath);
			return;
		} catch {
			await Bun.sleep(25);
		}
	}
	throw new Error(`Timed out waiting for RPC socket ${socketPath}`);
}

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

describe("--listen active-socket sink lifecycle", () => {
	it("keeps a newer socket after stale closure and survives a current-client response race", async () => {
		const socketPath = path.join(dir, "sink-lifecycle.sock");
		const proc = spawnRpcSocketServer(socketPath);
		let first: SocketClient | undefined;
		let second: SocketClient | undefined;
		let third: SocketClient | undefined;
		try {
			await waitForSocket(socketPath);
			first = await connectRpcSocket(socketPath);
			expect(await first.nextFrame()).toEqual({ type: "ready" });

			second = await connectRpcSocket(socketPath);
			expect(await second.nextFrame()).toEqual({ type: "ready" });
			first.close(); // Its later close callback must not detach the newer sink.
			await Bun.sleep(50);

			second.send({ id: "second-state", type: "get_state" });
			expect(await second.nextFrame()).toMatchObject({
				id: "second-state",
				type: "response",
				command: "get_state",
				success: true,
			});
			second.send({ id: "current-close", type: "get_state" });
			second.close();
			await Bun.sleep(50);
			expect(
				await Promise.race([
					proc.exited.then(() => "exited" as const),
					Bun.sleep(50).then(() => "running" as const),
				]),
			).toBe("running");

			third = await connectRpcSocket(socketPath);
			expect(await third.nextFrame()).toEqual({ type: "ready" });
			third.send({ id: "third-state", type: "get_state" });
			expect(await third.nextFrame()).toMatchObject({
				id: "third-state",
				type: "response",
				command: "get_state",
				success: true,
			});
		} finally {
			first?.close();
			second?.close();
			third?.close();
			proc.kill();
		}
	}, 45_000);
});
