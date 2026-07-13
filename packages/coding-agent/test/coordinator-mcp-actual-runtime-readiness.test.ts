import { describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../src/coordinator-mcp/server";

type JsonRecord = Record<string, unknown>;
type RecordedCommand = { command: string[]; at: number; exitCode: number; stdout: string; stderr: string };
type HttpRequest = {
	at: number;
	method: string;
	pathname: string;
	authorization: string | null;
	body: JsonRecord | null;
};

const DIST_SKC = path.resolve(import.meta.dir, "../dist/skc");
const POLL_INTERVAL_MS = 20;
const DEADLINE_MS = 15_000;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function runCommand(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function readJson(file: string): Promise<JsonRecord | null> {
	try {
		const text = await Bun.file(file).text();
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return null;
		throw error;
	}
}

async function waitFor<T>(
	description: string,
	predicate: () => Promise<T | null>,
	evidence: () => Promise<string>,
): Promise<T> {
	const deadline = Date.now() + DEADLINE_MS;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value !== null) return value;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`deadline exceeded waiting for ${description}\n${await evidence()}`);
}

function tmuxSubcommand(command: string[]): string | undefined {
	return command.find(value => ["set-buffer", "paste-buffer", "send-keys"].includes(value));
}

function isPromptDelivery(command: string[]): boolean {
	return command[0] === "tmux" && tmuxSubcommand(command) !== undefined;
}

const tmuxAvailable = Bun.which("tmux") !== null;
const supportedPlatform = process.platform === "linux" || process.platform === "darwin";
const builtBinaryAvailable = fsSync.existsSync(DIST_SKC);

const skipReason = !tmuxAvailable
	? "tmux is not installed"
	: !supportedPlatform
		? "platform or PTY support is unavailable"
		: !builtBinaryAvailable
			? "packages/coding-agent/dist/skc is missing because the build gate has not run"
			: null;
const smoke = skipReason ? it.skip : it;

describe("coordinator MCP actual runtime readiness", () => {
	smoke(
		skipReason ?? "gates the initial tmux prompt until the built runtime reports interactive readiness",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-actual-runtime-readiness-"));
			const workdir = path.join(root, "workdir");
			const agentDir = path.join(root, "agent");
			const stateRoot = path.join(root, "state");
			const commands: RecordedCommand[] = [];
			const requests: HttpRequest[] = [];
			let loopback: { port?: number; stop(closeActiveConnections?: boolean): void } | null = null;
			let sessionId = "";
			let diagnostics = "";

			const namespaceDir = path.join(stateRoot, "local", "repo");
			const sessionPath = () => path.join(namespaceDir, "sessions", `${sessionId}.json`);
			const turnPath = (turnId: string) => path.join(namespaceDir, "turns", `${turnId}.json`);
			const activeClaimPath = () => path.join(namespaceDir, "active-turns", `${sessionId}.json`);
			const runtimeStatePath = () => path.join(namespaceDir, "session-states", `${sessionId}.json`);
			const journalPath = path.join(namespaceDir, "events", "event-journal.jsonl");

			const evidence = async (): Promise<string> => {
				const pane = sessionId
					? await runCommand(["tmux", "capture-pane", "-p", "-t", `${sessionId}:0.0`]).then(
							result => result.stdout || result.stderr,
						)
					: "session id not observed";
				const session = sessionId ? await readJson(sessionPath()) : null;
				const turnFiles = await fs.readdir(path.join(namespaceDir, "turns")).catch(() => [] as string[]);
				const turns = await Promise.all(turnFiles.map(file => readJson(path.join(namespaceDir, "turns", file))));
				return JSON.stringify({
					pane,
					session,
					turns,
					activeClaim: sessionId ? await readJson(activeClaimPath()) : null,
					runtimeState: sessionId ? await readJson(runtimeStatePath()) : null,
					marker:
						session && typeof session.readiness_marker_file === "string"
							? await readJson(session.readiness_marker_file)
							: null,
					events: await Bun.file(journalPath)
						.text()
						.catch(() => ""),
					commands,
					requests,
				});
			};

			try {
				await fs.mkdir(workdir, { recursive: true });
				loopback = Bun.serve({
					port: 0,
					async fetch(request) {
						const url = new URL(request.url);
						const authorization = request.headers.get("authorization");
						let body: JsonRecord | null = null;
						if (request.method === "POST") body = JSON.parse(await request.text()) as JsonRecord;
						requests.push({
							at: Date.now(),
							method: request.method,
							pathname: url.pathname,
							authorization,
							body,
						});
						if (url.pathname === "/v1/models" && request.method === "GET") {
							expect(authorization).toBe("Bearer local-key");
							return Response.json({ data: [{ id: "local-alpha", object: "model", owned_by: "test" }] });
						}
						if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
							expect(authorization).toBe("Bearer local-key");
							expect(body?.model).toBe("local-alpha");
							expect(body?.stream).toBe(true);
							const chunks = [
								'data: {"id":"chatcmpl-readiness","object":"chat.completion.chunk","created":0,"model":"local-alpha","choices":[{"index":0,"delta":{"role":"assistant","content":"runtime readiness smoke complete"},"finish_reason":null}]}\n\n',
								'data: {"id":"chatcmpl-readiness","object":"chat.completion.chunk","created":0,"model":"local-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
								"data: [DONE]\n\n",
							];
							return new Response(
								new ReadableStream({
									start(controller) {
										for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
										controller.close();
									},
								}),
								{ headers: { "Content-Type": "text/event-stream" } },
							);
						}
						return new Response("not found", { status: 404 });
					},
				});
				const loopbackPort = loopback.port;
				if (typeof loopbackPort !== "number") throw new Error("loopback_port_unavailable");
				await Bun.write(
					path.join(agentDir, "models.json"),
					JSON.stringify({
						providers: {
							local: {
								baseUrl: `http://127.0.0.1:${loopbackPort}/v1`,
								apiKey: "local-key",
								api: "openai-completions",
								openaiCompat: { baseUrl: `http://127.0.0.1:${loopbackPort}`, apiKey: "local-key" },
								models: [
									{
										id: "local-alpha",
										name: "Local Alpha",
										api: "openai-completions",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 128000,
										maxTokens: 1024,
									},
								],
							},
						},
					}),
				);
				await Bun.write(path.join(agentDir, "config.yml"), "startup:\n  quiet: true\n");

				let ownerProbeCalls = 0;
				const server = createCoordinatorMcpServer({
					env: {
						SKC_COORDINATOR_MCP_WORKDIR_ROOTS: workdir,
						SKC_COORDINATOR_MCP_STATE_ROOT: stateRoot,
						SKC_COORDINATOR_MCP_MUTATIONS: "sessions",
						SKC_COORDINATOR_MCP_PROFILE: "local",
						SKC_COORDINATOR_MCP_REPO: "repo",
						SKC_COORDINATOR_MCP_RUNTIME_READINESS_TIMEOUT_MS: "10000",
						SKC_COORDINATOR_MCP_PROMPT_ACK_TIMEOUT_MS: "10000",
						SKC_COORDINATOR_MCP_SESSION_COMMAND: `env SKC_NO_UPDATE_CHECK=1 SKC_CODING_AGENT_DIR=${shellQuote(agentDir)} ${shellQuote(DIST_SKC)} --no-session --model local/local-alpha`,
					},
					services: {
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/user.slice/user-1.scope",
							probeServer: async () =>
								++ownerProbeCalls === 1
									? { state: "absent" }
									: {
											state: "safe",
											pid: process.pid,
											startTime: "actual-runtime-readiness",
											cgroup: { classification: "safe", scope: "/skc-owner-readiness.scope" },
										},
						},
						commandRunner: async command => {
							const at = Date.now();
							const result = await runCommand(command);
							commands.push({ command: [...command], at, ...result });
							return result;
						},
					},
				});

				const started = server.callTool("skc_coordinator_start_session", {
					cwd: workdir,
					prompt: "deterministic smoke prompt",
					allow_mutation: true,
				});
				const session = await waitFor(
					"coordinator session record",
					async () => {
						const files = await fs.readdir(path.join(namespaceDir, "sessions")).catch(() => [] as string[]);
						if (files.length !== 1) return null;
						sessionId = path.basename(files[0] ?? "", ".json");
						return await readJson(sessionPath());
					},
					evidence,
				);
				const launchId = session.launch_id;
				const markerFile = session.readiness_marker_file;
				expect(session).toMatchObject({
					session_id: sessionId,
					origin: "coordinator_created",
					launch_id: expect.any(String),
					readiness_marker_file: expect.any(String),
				});
				expect(typeof launchId).toBe("string");
				expect(typeof markerFile).toBe("string");

				const turn = await waitFor(
					"durable turn and active claim before delivery",
					async () => {
						const files = await fs.readdir(path.join(namespaceDir, "turns")).catch(() => [] as string[]);
						if (files.length !== 1) return null;
						const candidate = await readJson(turnPath(path.basename(files[0] ?? "", ".json")));
						const active = await readJson(activeClaimPath());
						return candidate && active?.turn_id === candidate.turn_id ? candidate : null;
					},
					evidence,
				);
				const turnAndClaimPersistedAt = Math.max(
					...(await Promise.all([fs.stat(turnPath(String(turn.turn_id))), fs.stat(activeClaimPath())])).map(
						stat => stat.mtimeMs,
					),
				);
				const marker = await waitFor(
					"runtime-authored readiness marker",
					() => readJson(markerFile as string),
					evidence,
				);
				const markerPersistedAt = (await fs.stat(markerFile as string)).mtimeMs;
				const markerCreatedAt = marker.created_at;
				expect(typeof markerCreatedAt).toBe("string");
				if (!Number.isFinite(Date.parse(String(markerCreatedAt)))) {
					throw new Error(`invalid_marker_timestamp:${JSON.stringify(marker)}`);
				}
				expect(marker).toMatchObject({
					schema_version: 1,
					session_id: sessionId,
					launch_id: launchId,
					state: "ready_for_input",
					event: "interactive_input_ready",
					source: "skc_interactive_runtime",
					ready_for_input: true,
				});

				await started;
				const injected = commands.filter(entry => isPromptDelivery(entry.command));
				expect(injected.map(entry => tmuxSubcommand(entry.command))).toEqual([
					"set-buffer",
					"paste-buffer",
					"send-keys",
					"send-keys",
				]);
				expect(injected).toHaveLength(4);
				expect(injected[2]?.command.at(-1)).toBe("Escape");
				expect(injected[3]?.command.at(-1)).toBe("Enter");
				expect(turnAndClaimPersistedAt).toBeLessThanOrEqual(injected[0]?.at ?? 0);
				expect(markerPersistedAt).toBeLessThanOrEqual(injected[0]?.at ?? 0);

				const readySession = await waitFor(
					"runtime readiness latch",
					async () => {
						const current = await readJson(sessionPath());
						return current &&
							current.runtime_ready_launch_id === launchId &&
							typeof current.runtime_ready_at === "string"
							? current
							: null;
					},
					evidence,
				);
				expect(readySession.runtime_ready_launch_id).toBe(launchId);
				expect(Date.parse(String(readySession.runtime_ready_at))).toBeLessThanOrEqual(injected[0]?.at ?? 0);
				const runtimeState = await waitFor(
					"runtime turn acknowledgement",
					async () => {
						const current = await readJson(runtimeStatePath());
						return current?.source === "agent_session_event" && current.current_turn_id === turn.turn_id
							? current
							: null;
					},
					evidence,
				);
				expect(["running", "completed", "errored"]).toContain(String(runtimeState.state));
				expect(Date.parse(String(runtimeState.updated_at))).toBeGreaterThanOrEqual(injected[3]?.at ?? 0);
				const completionRequest = await waitFor(
					"loopback completion request",
					async () => requests.find(request => request.pathname === "/v1/chat/completions") ?? null,
					evidence,
				);
				expect(completionRequest.at).toBeGreaterThanOrEqual(injected[3]?.at ?? 0);
				expect(requests.filter(request => request.pathname === "/v1/chat/completions")).toHaveLength(1);
			} catch (error) {
				diagnostics = await evidence();
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\nactual-runtime-readiness evidence: ${diagnostics}`,
				);
			} finally {
				if (sessionId) await runCommand(["tmux", "kill-session", "-t", sessionId]);
				loopback?.stop(true);
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
