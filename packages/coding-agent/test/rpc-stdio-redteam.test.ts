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

/**
 * `--mode rpc` was retired in favour of the SDK (docs/sdk.md); src/cli/args.ts
 * rejects it as a usage error before any stdio server can come up. These
 * red-team probes pin the stdio side of that removal boundary: the launch must
 * fail closed without reading stdin, emitting protocol frames, executing
 * commands, or touching durable state.
 */
const REMOVAL_MESSAGE = "--mode rpc was removed; external control now uses the Sayknow-CLI SDK (docs/sdk.md)";
const CRASH_NOISE = /(?:^|\n)(?:Error: )?(?:Error|TypeError|CliParseError):|\bat\s+\S+/;

interface Frame {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: unknown;
}

interface RefusedLaunch {
	exitCode: number;
	stdout: string;
	stderr: string;
	frames: Frame[];
}

interface RemovedRpcLaunch {
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	stderrText: Promise<string>;
	/** Lazily drains stdout so a test can leave it unread until after exit. */
	stdout(): Promise<string>;
	send(command: object | string): void;
	exited(timeoutMs?: number): Promise<number>;
	kill(): void;
}

let workspace: string;
let agentDir: string;
let cliEnv: HarnessCliEnv;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "rpc-redteam-ws-"));
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
		// Best-effort temp cleanup; tolerate env-specific node_modules layout.
	}
	await rm(workspace, { recursive: true, force: true });
});

/** Protocol frames are JSON object lines; usage text never parses as one. */
function jsonFrames(raw: string): Frame[] {
	const frames: Frame[] = [];
	for (const line of raw.split("\n")) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object") frames.push(parsed as Frame);
		} catch {
			// Not a frame.
		}
	}
	return frames;
}

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

function expectUsageRefusal(result: RefusedLaunch): void {
	expect(result.exitCode, result.stderr).toBe(2);
	expect(result.stdout).toContain("USAGE");
	expect(result.stderr).toContain(REMOVAL_MESSAGE);
	expect(result.stderr).not.toMatch(CRASH_NOISE);
	expect(result.frames).toEqual([]);
}

function launchRemovedRpc(options: { cwd?: string; sessionDir?: string } = {}): RemovedRpcLaunch {
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
			options.sessionDir ?? path.join(workspace, "sessions"),
		],
		{
			cwd: options.cwd ?? workspace,
			env: { ...cliEnv.env, SKC_HARNESS_STATE_ROOT: workspace, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrText = new Response(proc.stderr).text();
	let stdoutText: Promise<string> | undefined;

	return {
		proc,
		stderrText,
		stdout(): Promise<string> {
			stdoutText ??= new Response(proc.stdout).text();
			return stdoutText;
		},
		send(command: object | string): void {
			const line = typeof command === "string" ? command : JSON.stringify(command);
			proc.stdin.write(`${line}\n`);
		},
		exited(timeoutMs = 15_000): Promise<number> {
			return Promise.race([
				proc.exited,
				Bun.sleep(timeoutMs).then(() =>
					Promise.reject(new Error(`removed --mode rpc launch did not exit within ${timeoutMs}ms`)),
				),
			]);
		},
		kill(): void {
			try {
				proc.kill();
			} catch {
				// Process may already be gone.
			}
		},
	};
}

async function driveRemovedRpc(
	commands: Array<object | string>,
	options: { cwd?: string; sessionDir?: string } = {},
): Promise<RefusedLaunch> {
	const launch = launchRemovedRpc(options);
	const stdout = launch.stdout();
	for (const command of commands) launch.send(command);
	await launch.proc.stdin.end();
	const [raw, stderr, exitCode] = await Promise.all([stdout, launch.stderrText, launch.proc.exited]);
	return { frames: jsonFrames(raw), stdout: raw, stderr, exitCode };
}

describe("skc --mode rpc red-team stdio removal boundary", () => {
	it("is not an attached persistent server: refuses with the usage error while stdin stays open", async () => {
		const launch = launchRemovedRpc();
		const stdout = launch.stdout();
		try {
			launch.send({ id: "state-1", type: "get_state" });
			// stdin is deliberately never closed: a persistent server would block here.
			const exitCode = await launch.exited();
			const result = { exitCode, stdout: await stdout, stderr: await launch.stderrText };
			expectUsageRefusal({ ...result, frames: jsonFrames(result.stdout) });
			expect(await exists(path.join(workspace, "sessions"))).toBe(false);
		} finally {
			launch.kill();
		}
	}, 30_000);

	it("terminalizes without waiting for stdin EOF or a stdout consumer", async () => {
		const launch = launchRemovedRpc();
		try {
			// Neither end is serviced: stdin stays open and stdout is drained only after exit.
			const exitCode = await launch.exited();
			const stdout = await launch.stdout();
			expectUsageRefusal({ exitCode, stdout, stderr: await launch.stderrText, frames: jsonFrames(stdout) });
		} finally {
			launch.kill();
		}
	}, 30_000);

	it("creates no durable session state on EOF, so a later launch has nothing to reload", async () => {
		const sessionDir = path.join(workspace, "sessions");
		const firstRun = await driveRemovedRpc(
			[
				{ id: "name", type: "set_session_name", name: "persisted-redteam" },
				{ id: "bash", type: "bash", command: "printf RPC_PERSISTENCE_MARKER" },
				{ id: "state", type: "get_state" },
			],
			{ sessionDir },
		);
		expectUsageRefusal(firstRun);
		expect(await exists(sessionDir)).toBe(false);

		const secondRun = await driveRemovedRpc(
			[{ id: "switch", type: "switch_session", sessionPath: path.join(sessionDir, "missing.jsonl") }],
			{ sessionDir },
		);
		expectUsageRefusal(secondRun);
		expect(await exists(sessionDir)).toBe(false);
	}, 30_000);

	it("answers no mutation commands written before immediate stdin EOF", async () => {
		const result = await driveRemovedRpc([
			{ id: "first-name", type: "set_session_name", name: "first" },
			{ id: "second-name", type: "set_session_name", name: "second" },
		]);
		expectUsageRefusal(result);
		// The mutations provoke no per-command diagnostics: stderr is exactly the removal line.
		expect(result.stderr.trim()).toBe(REMOVAL_MESSAGE);
	}, 30_000);

	it("never parses stdin: a malformed JSONL frame yields no parse-failure frame and no crash", async () => {
		const result = await driveRemovedRpc([
			"{ definitely not json",
			{ id: "state-after-bad-frame", type: "get_state" },
		]);
		expectUsageRefusal(result);
		expect(result.frames.find(frame => frame.command === "parse")).toBeUndefined();
		expect(result.stderr.trim()).toBe(REMOVAL_MESSAGE);
	}, 30_000);

	it("rejects raw default selectors without mutating durable bytes", async () => {
		const configFile = path.join(agentDir, "config.yml");
		const modelsFile = path.join(agentDir, "models.yml");
		await writeFile(configFile, "modelRoles:\n  default: rpc-test/rpc-test-model:off\n");
		const configBaseline = await readBytesIfPresent(configFile);
		const modelsBaseline = await readBytesIfPresent(modelsFile);

		const result = await driveRemovedRpc([
			{ id: "bad-missing-provider", type: "set_default_model_selection", modelId: "rpc-test-model" },
			{ id: "bad-numeric-model", type: "set_default_model_selection", provider: "rpc-test", modelId: 42 },
			{ id: "bad-blank-provider", type: "set_default_model_selection", provider: " ", modelId: "rpc-test-model" },
			{
				id: "bad-invalid-level",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-model",
				thinkingLevel: "extreme",
			},
			{
				id: "bad-inherit-level",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-model",
				thinkingLevel: "inherit",
			},
			{ id: "bad-unknown-model", type: "set_default_model_selection", provider: "rpc-test", modelId: "missing" },
			{
				id: "well-formed",
				type: "set_default_model_selection",
				provider: "rpc-test",
				modelId: "rpc-test-model",
				thinkingLevel: "off",
			},
		]);
		expectUsageRefusal(result);
		expect(await readBytesIfPresent(configFile)).toEqual(configBaseline);
		expect(await readBytesIfPresent(modelsFile)).toEqual(modelsBaseline);
	}, 30_000);

	it("refuses independent concurrent launches without executing either lane's commands", async () => {
		const alphaCwd = path.join(workspace, "alpha");
		const betaCwd = path.join(workspace, "beta");
		await Promise.all([mkdir(alphaCwd, { recursive: true }), mkdir(betaCwd, { recursive: true })]);

		const [alpha, beta] = await Promise.all([
			driveRemovedRpc(
				[
					{ id: "name", type: "set_session_name", name: "orchestrated-alpha" },
					{ id: "state", type: "get_state" },
					{ id: "bash", type: "bash", command: "touch alpha-ran" },
				],
				{ cwd: alphaCwd, sessionDir: path.join(workspace, "sessions-alpha") },
			),
			driveRemovedRpc(
				[
					{ id: "name", type: "set_session_name", name: "orchestrated-beta" },
					{ id: "state", type: "get_state" },
					{ id: "bash", type: "bash", command: "touch beta-ran" },
				],
				{ cwd: betaCwd, sessionDir: path.join(workspace, "sessions-beta") },
			),
		]);

		expectUsageRefusal(alpha);
		expectUsageRefusal(beta);
		expect(await exists(path.join(alphaCwd, "alpha-ran"))).toBe(false);
		expect(await exists(path.join(betaCwd, "beta-ran"))).toBe(false);
		expect(await exists(path.join(workspace, "sessions-alpha"))).toBe(false);
		expect(await exists(path.join(workspace, "sessions-beta"))).toBe(false);
	}, 30_000);

	it("dispatches no bash or control commands from stdin (issue 13 boundary)", async () => {
		const marker = path.join(workspace, "bash-ran");
		const launch = launchRemovedRpc();
		const stdout = launch.stdout();
		try {
			launch.send({ id: "bash-1", type: "bash", command: `touch ${JSON.stringify(marker)}; sleep 5` });
			launch.send({ id: "abort-1", type: "abort_bash" });
			launch.send({ id: "state-1", type: "get_state" });

			const exitCode = await launch.exited();
			const raw = await stdout;
			expectUsageRefusal({ exitCode, stdout: raw, stderr: await launch.stderrText, frames: jsonFrames(raw) });
			// Give a wrongly dispatched bash a moment to leave evidence before checking.
			await Bun.sleep(200);
			expect(await exists(marker)).toBe(false);
		} finally {
			launch.kill();
		}
	}, 30_000);
});
