import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processIncarnation } from "@sayknow-cli/coding-agent/sdk/broker/process-incarnation";
import { ownerProofAvailable } from "@sayknow-cli/coding-agent/skc-runtime/session-restore-runtime";
import {
	buildSkcTmuxExactOptionTarget,
	buildSkcTmuxProfileCommands,
} from "@sayknow-cli/coding-agent/skc-runtime/tmux-common";
import { probeOwnerLiveness, replaceOwnerGeneration } from "@sayknow-cli/coding-agent/skc-runtime/tmux-owner-isolation";
import {
	forceCloseSkcTmuxSession,
	listSkcTmuxSessions,
	readTmuxSessionTagsForGc,
	statusSkcTmuxSession,
} from "@sayknow-cli/coding-agent/skc-runtime/tmux-sessions";

const tmux = Bun.which("tmux");
const systemdRun = Bun.which("systemd-run");
const isLinux = process.platform === "linux";
const isDarwin = process.platform === "darwin";
const isolatedServers: Array<{ env: NodeJS.ProcessEnv; stateDir: string; scopeName: string }> = [];
const userScopeAvailable =
	isLinux &&
	Boolean(systemdRun) &&
	Bun.spawnSync([systemdRun!, "--user", "--scope", "--quiet", "true"], { stdout: "pipe", stderr: "pipe" }).exitCode ===
		0;

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error(`owner process did not terminate: ${pid}`);
}

function run(args: string[], env: NodeJS.ProcessEnv): void {
	const result = Bun.spawnSync([env.SKC_TMUX_COMMAND!, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function procStartTime(pid: number): string {
	const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/)[19]!;
}

describe.skipIf(!isLinux || !tmux || !userScopeAvailable)("tmux exact owner close integration", () => {
	afterEach(async () => {
		for (const server of isolatedServers.splice(0)) {
			Bun.spawnSync([server.env.SKC_TMUX_COMMAND!, "kill-server"], {
				stdout: "pipe",
				stderr: "pipe",
				env: server.env,
			});
			Bun.spawnSync(["systemctl", "--user", "stop", server.scopeName], {
				stdout: "pipe",
				stderr: "pipe",
			});
			await fs.rm(server.stateDir, { recursive: true, force: true });
		}
	});

	it("uses TERM, publishes the expected verdict, then cleans up the real tmux session", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-tmux-close-integration-"));
		const tmuxTmpDir = path.join(stateDir, "tmux");
		const socketName = `skc-close-${crypto.randomUUID().slice(0, 8)}`;
		const scopeName = `skc-owner-test-${crypto.randomUUID().slice(0, 8)}.scope`;
		const tmuxWrapper = path.join(stateDir, "isolated-tmux");
		const sessionName = `skc_close_${crypto.randomUUID().slice(0, 8)}`;
		const siblingSessionName = `skc_sibling_${crypto.randomUUID().slice(0, 8)}`;
		const sessionId = crypto.randomUUID();
		const generation = crypto.randomUUID();
		const runId = crypto.randomUUID();
		const incarnation = crypto.randomUUID();
		await fs.mkdir(tmuxTmpDir);
		const stateFile = path.join(stateDir, "marker");
		const childScript = path.join(stateDir, "managed-child.ts");
		const supervisorScript = path.join(stateDir, "managed-supervisor.ts");
		const childReadyFile = path.join(stateDir, "managed-child-ready");
		await fs.writeFile(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				state: "completed",
				cwd: stateDir,
				workdir: stateDir,
				session_file: null,
				final_response: { source: "agent_end", text: "terminal evidence" },
			}),
		);
		await fs.writeFile(
			childScript,
			`import { writeFile } from "node:fs/promises";
import { registerCoordinatorRuntimeStateFinalizer } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/skc-runtime/session-state-sidecar.ts"))};
registerCoordinatorRuntimeStateFinalizer({ sessionId: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(stateDir)}, sessionFile: null });
await writeFile(${JSON.stringify(childReadyFile)}, JSON.stringify({ launched: process.env.SKC_TMUX_LAUNCHED, generation: process.env.SKC_TMUX_OWNER_GENERATION, stateDir: process.env.SKC_TMUX_OWNER_STATE_DIR, socketKey: process.env.SKC_TMUX_OWNER_SERVER_KEY }));
setInterval(() => {}, 1_000);
`,
		);
		await fs.writeFile(
			supervisorScript,
			`import { writeFile } from "node:fs/promises";
import { runManagedOwnerSupervisor } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/skc-runtime/managed-owner-supervisor.ts"))};
try {
	await runManagedOwnerSupervisor();
} catch (error) {
	await writeFile(${JSON.stringify(path.join(stateDir, "supervisor-error"))}, String(error));
	throw error;
}`,
		);
		await fs.writeFile(tmuxWrapper, `#!/usr/bin/env sh\nexec ${tmux} -L "$SKC_TEST_TMUX_SOCKET" "$@"\n`, {
			mode: 0o700,
		});
		const env = {
			...process.env,
			SKC_TMUX_COMMAND: tmuxWrapper,
			SKC_TEST_TMUX_SOCKET: socketName,
			TMUX_TMPDIR: tmuxTmpDir,
			SKC_TMUX_LAUNCHED: "1",
			SKC_TMUX_OWNER_GENERATION: generation,
			SKC_TMUX_OWNER_STATE_DIR: stateDir,
			SKC_TMUX_OWNER_SERVER_KEY: sessionName,
			SKC_COORDINATOR_SESSION_STATE_FILE: stateFile,
			SKC_COORDINATOR_SESSION_ID: sessionId,
			SKC_MANAGED_OWNER_RUN_ID: runId,
			SKC_MANAGED_OWNER_INCARNATION: incarnation,
			SKC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([process.execPath, childScript]),
		};
		isolatedServers.push({ env, stateDir, scopeName });
		const created = Bun.spawnSync(
			[
				systemdRun!,
				"--user",
				"--scope",
				"--quiet",
				"--unit",
				scopeName,
				env.SKC_TMUX_COMMAND!,
				"new-session",
				"-d",
				"-s",
				sessionName,
				`exec "${process.execPath}" "${supervisorScript}" 2>"${path.join(stateDir, "supervisor-stderr")}"`,
			],
			{ stdout: "pipe", stderr: "pipe", env },
		);
		if (created.exitCode !== 0) throw new Error(created.stderr.toString());
		for (let attempt = 0; attempt < 150 && !fsSync.existsSync(childReadyFile); attempt += 1) await Bun.sleep(20);
		if (!fsSync.existsSync(childReadyFile)) {
			const errorFile = path.join(stateDir, "supervisor-error");
			throw new Error(
				`managed owner child did not become ready: ${
					fsSync.existsSync(errorFile)
						? fsSync.readFileSync(errorFile, "utf8")
						: fsSync.existsSync(path.join(stateDir, "supervisor-stderr"))
							? fsSync.readFileSync(path.join(stateDir, "supervisor-stderr"), "utf8")
							: `files=${fsSync.readdirSync(stateDir).join(",")}`
				}`,
			);
		}
		expect(JSON.parse(await fs.readFile(childReadyFile, "utf8"))).toEqual({
			launched: "1",
			generation,
			stateDir,
			socketKey: sessionName,
		});
		const target = buildSkcTmuxExactOptionTarget(sessionName, { env });
		await replaceOwnerGeneration(stateDir, sessionId, generation);
		for (const command of buildSkcTmuxProfileCommands(
			target,
			env,
			{ sessionId, sessionStateFile: stateFile, ownerGeneration: generation, ownerServerKey: sessionName },
			{ tmuxCommand: env.SKC_TMUX_COMMAND },
		))
			run(command.args, env);
		run(["set-option", "-t", target, "remain-on-exit", "on"], env);
		run(
			["new-session", "-d", "-s", siblingSessionName, "sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
			env,
		);
		const hasSession = (name: string) =>
			Bun.spawnSync([env.SKC_TMUX_COMMAND!, "has-session", "-t", `=${name}`], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			});
		expect(hasSession(sessionName).exitCode).toBe(0);
		expect(hasSession(siblingSessionName).exitCode).toBe(0);
		expect(statusSkcTmuxSession(sessionName, env)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		expect(readTmuxSessionTagsForGc(sessionName, env)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		expect(listSkcTmuxSessions(env).find(session => session.name === sessionName)).toMatchObject({
			profile: "1",
			sessionId,
			sessionStateFile: stateFile,
		});
		const panePid = Number(
			Bun.spawnSync([env.SKC_TMUX_COMMAND!, "display-message", "-p", "-t", target, "#{pane_pid}"], {
				stdout: "pipe",
				stderr: "pipe",
				env,
			})
				.stdout.toString()
				.trim(),
		);
		expect(fsSync.readFileSync(`/proc/${panePid}/cmdline`, "utf8")).toContain(supervisorScript);
		await forceCloseSkcTmuxSession(sessionName, env, sessionId, stateFile, {
			resolveOwner: async () => ({
				sessionId,
				stateDir,
				socketKey: sessionName,
				generation,
				pid: panePid,
				startTime: procStartTime(panePid),
			}),
			readProcessStartTime: async pid => procStartTime(pid),
		});
		await waitForProcessExit(panePid);
		expect(() => process.kill(panePid, 0)).toThrow(/ESRCH/);
		expect(hasSession(sessionName).exitCode).not.toBe(0);
		expect(hasSession(siblingSessionName).exitCode).toBe(0);
		const verdict = JSON.parse(
			await fs.readFile(path.join(stateDir, sessionId, "owner-lifecycle", `verdict-${generation}.json`), "utf8"),
		);
		expect(verdict).toMatchObject({
			classification: "expected_operator_shutdown",
			observer: "sidecar",
			signal: "SIGTERM",
		});
		expect(JSON.parse(await fs.readFile(stateFile, "utf8"))).toMatchObject({
			state: "completed",
			final_response: { source: "agent_end", text: "terminal evidence" },
		});
	}, 10_000);
});

// Acceptance criterion 6: on Darwin the owner proof must be REAL, not the
// `{pid: 1, startTime: "not-applicable"}` sentinel the pre-fence code used. These
// run against a private tmux socket so the developer's own server is untouched.
describe.skipIf(!isDarwin || !tmux)("darwin owner proof", () => {
	const sockets: string[] = [];

	function isolatedTmuxEnv(): NodeJS.ProcessEnv {
		const socket = `skc-darwin-proof-${crypto.randomUUID().slice(0, 8)}`;
		sockets.push(socket);
		return { ...process.env, SKC_TMUX_COMMAND: `${tmux} -L ${socket}`, SKC_PSMUX_DETECTION: "off" };
	}

	afterEach(() => {
		for (const socket of sockets.splice(0)) {
			Bun.spawnSync([tmux!, "-L", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
		}
	});

	it("reads a real tmux server pid and a microsecond-resolution incarnation", () => {
		const socket = `skc-darwin-proof-${crypto.randomUUID().slice(0, 8)}`;
		sockets.push(socket);
		// A real server, so `#{pid}` is a real process we can bind an incarnation to.
		expect(
			Bun.spawnSync([tmux!, "-L", socket, "new-session", "-d", "-s", "proofcheck", "sleep", "30"], {
				stdout: "ignore",
				stderr: "ignore",
			}).exitCode,
		).toBe(0);

		const reported = Bun.spawnSync([tmux!, "-L", socket, "display-message", "-p", "#{pid}"], { stdout: "pipe" });
		const serverPid = Number.parseInt(reported.stdout.toString().trim(), 10);
		expect(Number.isSafeInteger(serverPid)).toBe(true);
		expect(serverPid).toBeGreaterThan(1);

		const incarnation = processIncarnation(serverPid);
		expect(incarnation).toBeDefined();
		// `darwin:<sec>:<usec>` — microsecond resolution is what makes same-second
		// PID reuse distinguishable, which second-precision `ps lstart` cannot do.
		expect(incarnation).toMatch(/^darwin:[1-9]\d*:\d+$/u);
		expect(processIncarnation(serverPid)).toBe(incarnation);
	});

	it("treats a changed incarnation for the same pid as a dead owner", () => {
		const incarnation = processIncarnation(process.pid);
		expect(incarnation).toBeDefined();
		if (!incarnation) return;
		expect(probeOwnerLiveness(process.pid, incarnation)).toBe("alive");
		// Same live pid, different incarnation: the recorded process is gone and the
		// pid was reused. Reporting "alive" here would let a stale reservation block
		// forever; reporting "dead" without the incarnation check would let a
		// successor displace a live owner.
		expect(probeOwnerLiveness(process.pid, "darwin:1:1")).toBe("dead");
	});

	it("refuses restore before any attempt or create when the provider is psmux", () => {
		// psmux exposes no immutable native session identity, so restore must fail
		// closed at the eligibility gate rather than reaching a spawn.
		expect(ownerProofAvailable({ ...process.env, SKC_TMUX_COMMAND: "psmux", SKC_PSMUX_COMMAND: "psmux" })).toBe(
			false,
		);
		const env = isolatedTmuxEnv();
		expect(ownerProofAvailable(env)).toBe(true);
	});
});
