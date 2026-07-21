import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
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

function liveFixtureModelsYaml(baseUrl: string): string {
	return `providers:
  rpc-test:
    auth: none
    api: openai-responses
    baseUrl: ${baseUrl}
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
}

interface Frame {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: { sessionId?: string; output?: string } & Record<string, unknown>;
	error?: unknown;
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

interface SocketConn {
	send(obj: object): void;
	nextResponse(id: string, timeoutMs?: number): Promise<Frame>;
	nextFrame(timeoutMs?: number): Promise<Frame>;
	close(): void;
}

async function readBytesIfPresent(filePath: string): Promise<Uint8Array | undefined> {
	const file = Bun.file(filePath);
	return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : undefined;
}

async function connect(socketPath: string): Promise<SocketConn> {
	const queue: Frame[] = [];
	const waiters: Array<{
		matches(frame: Frame): boolean;
		resolve(frame: Frame): void;
		timer: Timer;
	}> = [];
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buf = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_sock, bytes) {
				buf += decoder.decode(bytes);
				while (true) {
					const nl = buf.indexOf("\n");
					if (nl < 0) break;
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					const frame = JSON.parse(line) as Frame;
					const deliver = (): void => {
						const waiterIndex = waiters.findIndex(waiter => waiter.matches(frame));
						const waiter = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : undefined;
						if (waiter) {
							clearTimeout(waiter.timer);
							waiter.resolve(frame);
						} else queue.push(frame);
					};
					deliver();
				}
			},
		},
	});
	const nextMatchingFrame = (matches: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame> => {
		const queuedIndex = queue.findIndex(matches);
		if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
		const pending = Promise.withResolvers<Frame>();
		const waiter = {
			matches,
			resolve: pending.resolve,
			timer: setTimeout(() => {
				const waiterIndex = waiters.indexOf(waiter);
				if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
				pending.reject(new Error("timed out waiting for socket frame"));
			}, timeoutMs),
		};
		waiters.push(waiter);
		return pending.promise;
	};
	return {
		send(obj: object) {
			socket.write(`${JSON.stringify(obj)}\n`);
		},
		nextFrame(timeoutMs = 12_000) {
			return nextMatchingFrame(() => true, timeoutMs);
		},
		async nextResponse(id: string, timeoutMs = 15_000): Promise<Frame> {
			return nextMatchingFrame(frame => frame.type === "response" && frame.id === id, timeoutMs);
		},
		close() {
			socket.end();
		},
	};
}

async function waitForSocket(socketPath: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await stat(socketPath);
			return;
		} catch {
			await Bun.sleep(100);
		}
	}
	throw new Error(`socket ${socketPath} was not created`);
}

describe("skc --mode rpc --listen (UDS persistent server, issue 09)", () => {
	it("defers a durable default selection until a real streamed prompt completes", async () => {
		const streamStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const encoder = new TextEncoder();
		const responsesServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname !== "/v1/responses") return new Response("not found", { status: 404 });
				const body = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_rpc_test", model: "rpc-test-a", status: "in_progress" } })}\n\n`,
							),
						);
						streamStarted.resolve();
						await release.promise;
						const events = [
							{
								type: "response.output_item.added",
								output_index: 0,
								item: { id: "msg_rpc_test", type: "message", role: "assistant", content: [] },
							},
							{
								type: "response.content_part.added",
								item_id: "msg_rpc_test",
								output_index: 0,
								content_index: 0,
								part: { type: "output_text", text: "" },
							},
							{
								type: "response.output_text.delta",
								item_id: "msg_rpc_test",
								output_index: 0,
								content_index: 0,
								delta: "released",
							},
							{
								type: "response.output_text.done",
								item_id: "msg_rpc_test",
								output_index: 0,
								content_index: 0,
								text: "released",
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: {
									id: "msg_rpc_test",
									type: "message",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "released" }],
								},
							},
							{
								type: "response.completed",
								response: {
									id: "resp_rpc_test",
									model: "rpc-test-a",
									status: "completed",
									output: [],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							},
						];
						controller.enqueue(
							encoder.encode(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`),
						);
						controller.close();
					},
					cancel() {
						release.resolve();
					},
				});
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			},
		});
		await writeFile(path.join(agentDir, "models.yml"), liveFixtureModelsYaml(`${responsesServer.url}v1`));
		const firstSocketPath = path.join(workspace, "rpc-default-selection.sock");
		const restartSocketPath = path.join(workspace, "rpc-default-selection-restart.sock");
		const sessionDir = path.join(workspace, "sessions-default-selection");
		const configFile = path.join(agentDir, "config.yml");
		const firstProc = Bun.spawn(
			[
				"bun",
				cliEntry,
				"--mode",
				"rpc",
				"--provider",
				"rpc-test",
				"--model",
				"rpc-test-a",
				"--session-dir",
				sessionDir,
				"--listen",
				firstSocketPath,
			],
			{
				cwd: workspace,
				env: { ...cliEnv.env, SKC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const firstStderrText = new Response(firstProc.stderr).text();
		let connection: SocketConn | undefined;
		let restartConnection: SocketConn | undefined;
		let restartProc: Bun.Subprocess | undefined;
		try {
			await waitForSocket(firstSocketPath);
			connection = await connect(firstSocketPath);
			expect(await connection.nextFrame()).toEqual({ type: "ready" });
			connection.send({ id: "state-baseline", type: "get_state" });
			const baselineState = await connection.nextResponse("state-baseline");
			const sessionFile = baselineState.data?.sessionFile;
			if (typeof sessionFile !== "string") throw new Error("Expected get_state to return a session file");

			connection.send({ id: "prompt-1", type: "prompt", message: "hold" });
			const promptResponse = connection.nextResponse("prompt-1");
			await streamStarted.promise;
			connection.send({ id: "state-streaming", type: "get_state" });
			expect(await connection.nextResponse("state-streaming")).toMatchObject({
				command: "get_state",
				success: true,
				data: { isStreaming: true },
			});

			const configBeforeSelection = await readBytesIfPresent(configFile);
			const sessionBeforeSelection = await readBytesIfPresent(sessionFile);
			connection.send({
				id: "select-1",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-b",
				thinkingLevel: "off",
			});
			let selectionSettled = false;
			const selectionResponse = connection.nextResponse("select-1").then(frame => {
				selectionSettled = true;
				return frame;
			});
			connection.send({ id: "state-held", type: "get_state" });
			expect(await connection.nextResponse("state-held")).toMatchObject({
				command: "get_state",
				success: true,
				data: { isStreaming: true, model: { provider: "rpc-test", id: "rpc-test-a" } },
			});
			expect(selectionSettled).toBe(false);
			expect(await readBytesIfPresent(configFile)).toEqual(configBeforeSelection);
			expect(await readBytesIfPresent(sessionFile)).toEqual(sessionBeforeSelection);

			release.resolve();
			expect(await promptResponse).toMatchObject({ id: "prompt-1", command: "prompt", success: true });
			expect(await selectionResponse).toMatchObject({
				id: "select-1",
				command: "set_default_model_selection",
				success: true,
				data: { provider: "rpc-test", modelId: "rpc-test-b", thinkingLevel: "off" },
			});
			expect(YAML.parse(await Bun.file(configFile).text())).toMatchObject({
				modelRoles: { default: "rpc-test/rpc-test-b:off" },
			});
			connection.send({ id: "state-selected", type: "get_state" });
			expect(await connection.nextResponse("state-selected")).toMatchObject({
				command: "get_state",
				success: true,
				data: {
					isStreaming: false,
					model: { provider: "rpc-test", id: "rpc-test-b" },
					thinkingLevel: "off",
				},
			});

			const sessionEntries: Array<Record<string, unknown>> = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			const defaultMarkers = sessionEntries.filter(
				entry => entry.type === "model_change" && entry.role === "default" && entry.model === "rpc-test/rpc-test-b",
			);
			expect(defaultMarkers).toHaveLength(1);
			const userIndex = sessionEntries.findIndex(
				entry =>
					entry.type === "message" &&
					typeof entry.message === "object" &&
					entry.message !== null &&
					"role" in entry.message &&
					entry.message.role === "user",
			);
			const assistantIndex = sessionEntries.findIndex(
				entry =>
					entry.type === "message" &&
					typeof entry.message === "object" &&
					entry.message !== null &&
					"role" in entry.message &&
					entry.message.role === "assistant",
			);
			const markerIndex = sessionEntries.indexOf(defaultMarkers[0]);
			expect(userIndex).toBeGreaterThanOrEqual(0);
			expect(assistantIndex).toBeGreaterThan(userIndex);
			expect(markerIndex).toBeGreaterThan(assistantIndex);

			const configAfterSelection = await readBytesIfPresent(configFile);
			const sessionAfterSelection = await readBytesIfPresent(sessionFile);
			connection.send({
				id: "select-bad",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-missing",
				thinkingLevel: "off",
			});
			expect(await connection.nextResponse("select-bad")).toMatchObject({
				id: "select-bad",
				command: "set_default_model_selection",
				success: false,
			});
			expect(await readBytesIfPresent(configFile)).toEqual(configAfterSelection);
			expect(await readBytesIfPresent(sessionFile)).toEqual(sessionAfterSelection);
			connection.send({ id: "state-after-bad", type: "get_state" });
			expect(await connection.nextResponse("state-after-bad")).toMatchObject({
				command: "get_state",
				success: true,
				data: { model: { provider: "rpc-test", id: "rpc-test-b" } },
			});

			connection.close();
			connection = undefined;
			firstProc.kill();
			await firstProc.exited;
			expect(Bun.spawnSync(["kill", "-0", String(firstProc.pid)]).exitCode).not.toBe(0);
			expect(await Bun.file(firstSocketPath).exists()).toBe(false);
			expect((await firstStderrText).trim()).toBe("");

			restartProc = Bun.spawn(
				["bun", cliEntry, "--mode", "rpc", "--session-dir", sessionDir, "--listen", restartSocketPath],
				{
					cwd: workspace,
					env: { ...cliEnv.env, SKC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			await waitForSocket(restartSocketPath);
			restartConnection = await connect(restartSocketPath);
			expect(await restartConnection.nextFrame()).toEqual({ type: "ready" });
			restartConnection.send({ id: "state-restart", type: "get_state" });
			expect(await restartConnection.nextResponse("state-restart")).toMatchObject({
				command: "get_state",
				success: true,
				data: {
					model: { provider: "rpc-test", id: "rpc-test-b" },
					thinkingLevel: "off",
				},
			});
		} finally {
			release.resolve();
			connection?.close();
			restartConnection?.close();
			firstProc.kill();
			await firstProc.exited;
			if (restartProc) {
				restartProc.kill();
				await restartProc.exited;
				expect(Bun.spawnSync(["kill", "-0", String(restartProc.pid)]).exitCode).not.toBe(0);
			}
			responsesServer.stop(true);
			expect(await Bun.file(firstSocketPath).exists()).toBe(false);
			expect(await Bun.file(restartSocketPath).exists()).toBe(false);
			await rm(workspace, { recursive: true, force: true });
		}
	}, 60_000);

	it("rejects malformed raw default selectors without mutating durable bytes or losing UDS service", async () => {
		const socketPath = path.join(workspace, "rpc-malformed.sock");
		const proc = Bun.spawn(
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
				path.join(workspace, "sessions-malformed"),
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
		const stderrText = new Response(proc.stderr).text();
		let connection: SocketConn | undefined;
		const malformed = [
			{ id: "uds-missing-provider", type: "set_default_model_selection", modelId: "rpc-test-model" },
			{ id: "uds-numeric-model", type: "set_default_model_selection", provider: "rpc-test", modelId: 42 },
			{ id: "uds-blank-provider", type: "set_default_model_selection", provider: " ", modelId: "rpc-test-model" },
			{
				id: "uds-invalid-level",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-model",
				thinkingLevel: "extreme",
			},
			{
				id: "uds-inherit-level",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-model",
				thinkingLevel: "inherit",
			},
			{ id: "uds-unknown-model", type: "set_default_model_selection", provider: "rpc-test", modelId: "missing" },
		] as const;
		try {
			// Given: the real socket is ready and durable baselines are captured only after initial state.
			await waitForSocket(socketPath);
			connection = await connect(socketPath);
			expect(await connection.nextFrame()).toEqual({ type: "ready" });
			connection.send({ id: "uds-baseline", type: "get_state" });
			const initialState = await connection.nextResponse("uds-baseline");
			expect(initialState).toMatchObject({ command: "get_state", success: true });
			const sessionFile = initialState.data?.sessionFile;
			if (typeof sessionFile !== "string") throw new Error("Expected UDS get_state to return a session file");
			const configFile = path.join(agentDir, "config.yml");
			const configBaseline = await readBytesIfPresent(configFile);
			const sessionBaseline = await readBytesIfPresent(sessionFile);

			for (const [index, command] of malformed.entries()) {
				// When: each raw mutation response arrives before its fast-lane state probe is sent.
				connection.send(command);
				const failure = await connection.nextResponse(command.id);

				// Then: correlation, survival, and both durable byte snapshots remain exact.
				expect(failure).toMatchObject({
					id: command.id,
					command: "set_default_model_selection",
					success: false,
				});
				expect(failure.command).not.toBe("parse");
				expect(JSON.stringify(failure.error)).not.toContain("Unknown command");
				connection.send({ id: `uds-state-after-${index}`, type: "get_state" });
				expect(await connection.nextResponse(`uds-state-after-${index}`)).toMatchObject({
					command: "get_state",
					success: true,
				});
				expect(await readBytesIfPresent(configFile)).toEqual(configBaseline);
				expect(await readBytesIfPresent(sessionFile)).toEqual(sessionBaseline);
			}
		} finally {
			connection?.close();
			proc.kill();
			await proc.exited;
			expect(Bun.spawnSync(["kill", "-0", String(proc.pid)]).exitCode).not.toBe(0);
			expect(await Bun.file(socketPath).exists()).toBe(false);
			expect((await stderrText).trim()).toBe("");
		}
	}, 45_000);

	it("keeps the AgentSession alive across client reconnects", async () => {
		const socketPath = path.join(workspace, "rpc.sock");
		const proc = Bun.spawn(
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
		try {
			await waitForSocket(socketPath);

			const first = await connect(socketPath);
			expect(await first.nextFrame()).toEqual({ type: "ready" });
			first.send({ id: "s1", type: "get_state" });
			const state1 = await first.nextResponse("s1");
			expect(state1.success).toBe(true);
			const sessionId = state1.data?.sessionId;
			expect(sessionId).toBeTruthy();
			first.close();

			// The server must remain alive after the client disconnects.
			await Bun.sleep(400);
			expect(proc.killed).toBe(false);

			const second = await connect(socketPath);
			expect(await second.nextFrame()).toEqual({ type: "ready" });
			second.send({ id: "s2", type: "get_state" });
			const state2 = await second.nextResponse("s2");
			// Same session survived the reconnect.
			expect(state2.data?.sessionId).toBe(sessionId);

			// Still functional after reconnect.
			second.send({ id: "b1", type: "bash", command: "echo persisted-across-reconnect" });
			const bash = await second.nextResponse("b1");
			expect(bash.success).toBe(true);
			expect(bash.data?.output).toContain("persisted-across-reconnect");
			second.close();
		} finally {
			proc.kill();
		}
	}, 45_000);

	it("registers a discoverable socket record while listening", async () => {
		const socketPath = path.join(workspace, "rpc2.sock");
		const proc = Bun.spawn(
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
				path.join(workspace, "sessions2"),
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
		try {
			await waitForSocket(socketPath);
			const { listRpcSessions } = await import("@sayknow-cli/coding-agent/modes/shared/agent-wire/session-registry");
			const sessions = await listRpcSessions(agentDir);
			const socketRecord = sessions.find(s => s.transport === "socket");
			expect(socketRecord).toBeDefined();
			expect(socketRecord?.endpoint).toBe(socketPath);
		} finally {
			proc.kill();
		}
	}, 45_000);
});
