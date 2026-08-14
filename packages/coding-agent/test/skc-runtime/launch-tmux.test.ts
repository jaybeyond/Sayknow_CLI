import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@sayknow-cli/coding-agent";
import type { Args } from "@sayknow-cli/coding-agent/cli/args";
import {
	applySkcTmuxProfile,
	buildDefaultTmuxLaunchPlan,
	buildSkcTmuxProfileCommands,
	buildSkcTmuxWindowTitle,
	launchDefaultTmuxIfNeeded,
	SKC_TMUX_LAUNCHED_ENV,
	SKC_TMUX_SESSION_PREFIX,
	type TmuxSpawnOptions,
} from "@sayknow-cli/coding-agent/skc-runtime/launch-tmux";
import { __setBinaryResolverForTests } from "@sayknow-cli/coding-agent/skc-runtime/psmux-detect";
import { sessionRuntimeDir } from "@sayknow-cli/coding-agent/skc-runtime/session-layout";
import {
	__setOwnerIncarnationReaderForTests,
	releaseIdentityCreate,
	reserveIdentityCreate,
} from "@sayknow-cli/coding-agent/skc-runtime/tmux-owner-isolation";
import { setAgentDir } from "@sayknow-cli/utils/dirs";

function args(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...overrides,
	};
}

const TEST_SESSION_ID = "test-session";
const interactiveTty = { stdin: true, stdout: true };
type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

let previousSkcSessionId: string | undefined;

beforeAll(() => {
	previousSkcSessionId = process.env.SKC_SESSION_ID;
	process.env.SKC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousSkcSessionId === undefined) {
		delete process.env.SKC_SESSION_ID;
	} else {
		process.env.SKC_SESSION_ID = previousSkcSessionId;
	}
});
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("default SKC tmux launch", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
		vi.restoreAllMocks();
	});

	it("builds sanitized project and branch tmux window titles", () => {
		expect(buildSkcTmuxWindowTitle("/repo", "feature/demo")).toBe("repo-feature/demo");
		expect(buildSkcTmuxWindowTitle("/repo", "main")).toBe("repo-main");
		expect(buildSkcTmuxWindowTitle("/repo", null)).toBe("repo");
		expect(buildSkcTmuxWindowTitle("/repo", "")).toBe("repo");
	});

	it("replaces colon-bearing tmux window title segments", () => {
		expect(buildSkcTmuxWindowTitle("/repo:backend", "main")).toBe("repo-backend-main");
		expect(buildSkcTmuxWindowTitle("/repo", "release:main")).toBe("repo-release-main");
		expect(buildSkcTmuxWindowTitle("/repo", "feature:::demo")).toBe("repo-feature-demo");
	});

	it("truncates long tmux window titles to 48 visible columns while preserving the project and branch tail", () => {
		const title = buildSkcTmuxWindowTitle("/repo", `feature/${"a".repeat(80)}tail`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("repo-…")).toBe(true);
		expect(title.endsWith("tail")).toBe(true);
	});

	it("truncates wide-character tmux window titles by visible width while preserving the branch tail", () => {
		const title = buildSkcTmuxWindowTitle("/저장소", `feature/${"界".repeat(80)}끝`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("저장소-…")).toBe(true);
		expect(title.endsWith("끝")).toBe(true);
	});

	it("sanitizes dot-prefixed cwd basenames for tmux window titles", () => {
		expect(buildSkcTmuxWindowTitle("/tmp/.claude", null)).toBe("dot-claude");
		expect(buildSkcTmuxWindowTitle("/tmp/.claude", "feature/demo")).toBe("dot-claude-feature/demo");
		expect(buildSkcTmuxWindowTitle("/tmp/.claude", "repo:main")).toBe("dot-claude-repo-main");
		expect(buildSkcTmuxWindowTitle("/tmp/...", null)).toBe("skc");
		expect(buildSkcTmuxWindowTitle("/tmp/...", "feature/demo")).toBe("skc-feature/demo");
	});

	it("passes sanitized dot-prefixed cwd basenames to tmux rename-window", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/tmp/.claude",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.find(call => call.args[0] === "rename-window")?.args).toEqual([
			"rename-window",
			"-t",
			expect.stringMatching(/^=sayknow_cli_/),
			"--",
			"dot-claude",
		]);
	});

	it("separates dash-leading tmux window titles from tmux options", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/tmp/-repo",
			env: { TMUX: "/tmp/tmux" },
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls[0]?.args).toEqual(["rename-window", "--", "-repo-feature/demo"]);
	});

	it("does not plan tmux for interactive root launch without --tmux", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeUndefined();
	});

	it("does not invoke tmux session listing when existing session lookup is injected", () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync");
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		// Only assert the session-listing command family. The psmux detection
		// probe may issue a one-time tmux 3.3 to detect the multiplexer and
		// that is intentionally out of scope for this test.
		const listSessionsCalls = spawnSyncSpy.mock.calls.filter(call => call[0]?.[1] === "list-sessions");
		expect(listSessionsCalls).toHaveLength(0);
	});

	it("plans an interactive --tmux root launch inside a new SKC tmux session", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.sessionName.startsWith(SKC_TMUX_SESSION_PREFIX)).toBe(true);
		expect(plan.tmuxCommand).toBe("tmux");
		expect(plan.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", plan.sessionName, "-c", "/repo"]);
		expect(plan?.innerCommand).toContain("'/bin/bun' '/repo/packages/coding-agent/src/cli.ts' 'hello world'");
		expect(plan?.innerCommand).not.toContain("'--tmux'");
		expect(plan.innerCommand).toContain("SKC_COORDINATOR_SESSION_ID=");
		expect(plan.innerCommand).toContain("SKC_COORDINATOR_SESSION_STATE_FILE=");
	});

	it("plans native Windows --tmux launches when tmux is available", () => {
		// The historical direct-launch fallback only fires when no tmux binary
		// resolves on PATH. When psmux / tmux is available,
		// buildDefaultTmuxLaunchPlan returns a plan that bootstraps skc through
		// PowerShell. Set tmuxAvailable: true here to mirror a host with psmux.
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "C:\\repo",
			env: {},
			argv: ["C:\\Program Files\\SKC\\skc.exe"],
			execPath: "C:\\Program Files\\SKC\\skc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
	});

	it("uses a host command for compiled Bun virtual entrypoints", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["skc", "/$bunfs/root/skc-linux-x64"],
			execPath: "/home/me/.local/bin/skc",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.innerCommand).not.toContain("$bunfs");
		expect(plan.innerCommand).toContain(`${SKC_TMUX_LAUNCHED_ENV}=1`);
		expect(plan.innerCommand).toContain("'/home/me/.local/bin/skc' 'hello world'");
	});

	it("falls back to skc when compiled Bun virtual entrypoint has no host exec path", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux"],
			cwd: "/repo",
			env: {},
			argv: ["skc", "/$bunfs/root/skc-linux-x64"],
			execPath: "/$bunfs/root/skc-linux-x64",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan?.innerCommand).not.toContain("$bunfs");
		expect(plan?.innerCommand).toContain("'skc'");
	});

	it("does not implicitly attach existing tagged session for plain worktree branch launch", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "sayknow_cli_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session" && call.args[2] === "=sayknow_cli_feature")).toBe(
			false,
		);
	});

	it("explicit continue attaches existing tagged session for matching worktree branch", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "sayknow_cli_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=sayknow_cli_feature"]);
	});

	it("uses bare session targets for psmux attach paths", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		try {
			const handled = launchDefaultTmuxIfNeeded({
				parsed: args({ messages: ["hello world"], tmux: true, resume: true }),
				rawArgs: ["--tmux", "--resume", "hello world"],
				cwd: "/repo",
				env: { SKC_TMUX_COMMAND: "psmux", SKC_PSMUX_COMMAND: "psmux" },
				argv: ["bun", "packages/coding-agent/src/cli.ts"],
				execPath: "/bin/bun",
				platform: "win32",
				tty: interactiveTty,
				tmuxAvailable: true,
				worktreeBranch: "feature/demo",
				existingBranchSessionName: "sayknow_cli_feature",
				spawnSync: (command, spawnArgs, options) => {
					calls.push({ command, args: spawnArgs, options });
					return { exitCode: 0 };
				},
			});

			expect(handled).toBe(true);
			expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "sayknow_cli_feature"]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("explicit resume attaches existing tagged session for matching worktree branch", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, resume: true }),
			rawArgs: ["--tmux", "--resume", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "sayknow_cli_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=sayknow_cli_feature"]);
	});

	it("falls through to a fresh session when existing tagged session attach fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true, resume: true }),
			rawArgs: ["--tmux", "--resume", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			existingBranchSessionName: "sayknow_cli_feature",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session" && spawnArgs[2] === "=sayknow_cli_feature") return { exitCode: 1 };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls[0]?.args).toEqual(["attach-session", "-t", "=sayknow_cli_feature"]);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session" && call.args[2] !== "=sayknow_cli_feature")).toBe(
			true,
		);
	});

	it("does not reuse same-branch sessions from another project", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo-b/worktree",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			worktreeBranch: "feature/demo",
			project: "/repo-b",
			existingBranchSessionName: null,
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.branch).toBe("feature/demo");
		expect(plan?.project).toBe("/repo-b");
	});

	it("honors an explicit SKC_TMUX_SESSION override", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, "custom-skc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo"),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { SKC_TMUX_SESSION: "custom-skc" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
		});

		expect(plan?.sessionName).toBe("custom-skc");
		expect(plan?.attachSessionName).toBe("custom-skc");
		expect(plan?.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", "custom-skc", "-c", "/repo"]);
	});

	it("honors explicit SKC_TMUX_COMMAND on native Windows without direct-launch fallback", () => {
		// Once psmux is a supported Windows multiplexer, an explicit
		// SKC_TMUX_COMMAND override must always produce a tmux plan. The
		// legacy direct-launch fallback only fires when no tmux provider is
		// resolvable on PATH; the user has named a multiplexer here so the
		// buildDefaultTmuxLaunchPlan path is authoritative. Runtime failures
		// surface through the normal spawn-failure diagnostics instead of a
		// silent direct launch.
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "C:\\repo",
			env: { SKC_TMUX_COMMAND: "psmux" },
			argv: ["C:\\Program Files\\SKC\\skc.exe"],
			execPath: "C:\\Program Files\\SKC\\skc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
	});
	it("does not auto-reuse scoped sessions from another SKC version", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				"old-skc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\told-session\t/state\t0.0.0",
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.newSessionArgs.slice(0, 2)).toEqual(["new-session", "-d"]);
	});

	it("does not auto-reuse scoped sessions from the current SKC version without explicit resume", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				`current-skc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t\t${VERSION}\t$1`,
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBeUndefined();
	});

	it("auto-reuses scoped sessions from the current SKC version for explicit continue", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				`current-skc\t1\t0\t1770000000\t1\troot\t1\t12345\tfeature/demo\tfeature-demo\t/repo\tcurrent-session\t/state\t\t${VERSION}\t$1`,
			),
		);
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true, continue: true }),
			rawArgs: ["--tmux", "--continue", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo",
		});

		expect(plan?.attachSessionName).toBe("current-skc");
	});

	it("does not reuse a same-branch session from another worktree path in the same project", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo/worktree-b",
			env: {},
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "feature/demo",
			project: "/repo/worktree-b",
			existingBranchSessionName: null,
		});

		expect(plan?.attachSessionName).toBeUndefined();
		expect(plan?.branch).toBe("feature/demo");
		expect(plan?.project).toBe("/repo/worktree-b");
	});

	it("cleans up a newly created managed session when attach fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				// Real tmux answers this; a stub that does not is not modelling tmux.
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$3\t7777\t1700000000\n" };
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		// Cleanup is now proven and atomic: one invocation both checks and kills.
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(true);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: attach failed.");
	});

	it("builds a session-scoped tmux profile without global tmux mutation", () => {
		const commands = buildSkcTmuxProfileCommands("skc-session:0", {});
		const args = commands.map(command => command.args);

		expect(args).toContainEqual(["set-option", "-t", "skc-session:0", "mouse", "on"]);
		expect(args).toContainEqual(["set-option", "-t", "skc-session:0", "@skc-profile", "1"]);
		expect(args).toContainEqual(["set-option", "-t", "skc-session:0", "set-clipboard", "on"]);
		expect(args).toContainEqual([
			"set-window-option",
			"-t",
			"skc-session:0",
			"mode-style",
			"fg=colour231,bg=colour60",
		]);
		expect(args.flat()).not.toContain("-g");
		expect(
			buildSkcTmuxProfileCommands("skc-session:0", { SKC_TMUX_PROFILE: "false" }).map(command => command.args),
		).toEqual([["set-option", "-t", "skc-session:0", "@skc-profile", "1"]]);
		expect(
			buildSkcTmuxProfileCommands("skc-session:0", { SKC_MOUSE: "off" }).flatMap(command => command.args),
		).not.toContain("mouse");
	});

	it("records session identity markers in the required tmux profile", () => {
		const commands = buildSkcTmuxProfileCommands(
			"skc-session:0",
			{},
			{
				sessionId: "session-123",
				sessionStateFile: "/tmp/skc-state/session.json",
				version: VERSION,
			},
		);
		const args = commands.map(command => command.args);

		expect(args).toContainEqual(["set-option", "-t", "skc-session:0", "@skc-session-id", "session-123"]);
		expect(args).toContainEqual([
			"set-option",
			"-t",
			"skc-session:0",
			"@skc-session-state-file",
			"/tmp/skc-state/session.json",
		]);
		expect(args).toContainEqual(["set-option", "-t", "skc-session:0", "@skc-version", VERSION]);
	});

	it("plans matching tmux marker tags and inner process marker env", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { SKC_SESSION_ID: TEST_SESSION_ID },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.sessionId).toBe(plan.sessionName);
		if (!plan.sessionId || !plan.sessionStateFile) throw new Error("expected tmux session id and state file");
		// The runtime state path is rooted on the SKC session (SKC_SESSION_ID), not the
		// coordinator/tmux identity.
		expect(path.dirname(plan.sessionStateFile)).toBe(
			path.join(sessionRuntimeDir("/repo", TEST_SESSION_ID), "tmux-sessions"),
		);
		expect(plan.innerCommand).toContain(`SKC_COORDINATOR_SESSION_ID='${plan.sessionId}'`);
		expect(plan.innerCommand).toContain(`SKC_COORDINATOR_SESSION_STATE_FILE='${plan.sessionStateFile}'`);
	});

	it("roots runtime state on SKC_SESSION_ID even when SKC_COORDINATOR_SESSION_ID differs", () => {
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { SKC_SESSION_ID: "skc-sess", SKC_COORDINATOR_SESSION_ID: "coord-sess" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
		});
		expect(plan).toBeDefined();
		if (!plan?.sessionStateFile) throw new Error("expected tmux plan with state file");
		// Coordinator identity is the coordinator id; the state-file root is the SKC session.
		expect(plan.sessionId).toBe("coord-sess");
		expect(path.dirname(plan.sessionStateFile)).toBe(
			path.join(sessionRuntimeDir("/repo", "skc-sess"), "tmux-sessions"),
		);
	});

	it("applies the tmux profile only to the requested target", () => {
		const calls: { command: string; args: string[] }[] = [];
		const result = applySkcTmuxProfile({
			tmuxCommand: "tmux",
			target: "%7",
			cwd: "/repo",
			env: {},
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(result.skipped).toBe(false);
		expect(result.failures).toEqual([]);
		// Name the profile rather than counting it: adding a setting must be a
		// deliberate edit here, and a silently dropped one still fails.
		expect(calls.map(call => call.args[call.args.length - 2])).toEqual([
			"mouse",
			"@skc-profile",
			"set-clipboard",
			"terminal-features",
			"allow-passthrough",
			"mode-style",
		]);
		expect(calls.every(call => call.command === "tmux")).toBe(true);
		expect(calls.every(call => call.args.includes("-t") && call.args.includes("%7"))).toBe(true);
		expect(calls.flatMap(call => call.args)).not.toContain("-g");
	});

	it("does not wrap non-interactive or already wrapped launches", () => {
		const common = {
			rawArgs: [],
			cwd: "/repo",
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin" as const,
			tty: interactiveTty,
			tmuxAvailable: true,
		};

		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ print: true }), env: {} })).toBeUndefined();
		expect(buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ mode: "json" }), env: {} })).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({ ...common, parsed: args({ tmux: true }), env: { TMUX: "/tmp/tmux" } }),
		).toBeUndefined();
		expect(
			buildDefaultTmuxLaunchPlan({
				...common,
				parsed: args({ tmux: true }),
				env: { [SKC_TMUX_LAUNCHED_ENV]: "1" },
			}),
		).toBeUndefined();
	});

	it("renames the current window for direct interactive launches inside tmux", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {
				TMUX: "/tmp/tmux",
			},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			command: "tmux",
			args: ["rename-window", "--", "repo-feature/demo"],
		});
	});

	it("does not rename direct launches already inside a SKC-launched tmux wrapper", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"] }),
			rawArgs: ["hello world"],
			cwd: "/repo",
			env: {
				TMUX: "/tmp/tmux",
				[SKC_TMUX_LAUNCHED_ENV]: "1",
			},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toEqual([]);
	});

	it("skips direct tmux rename when guard conditions are not met", () => {
		const cases = [
			{
				name: "non-interactive",
				parsed: args({ print: true }),
				env: { TMUX: "/tmp/tmux" },
				tmuxAvailable: true,
			},
			{
				name: "tmux unavailable",
				parsed: args({ messages: ["hello world"] }),
				env: { TMUX: "/tmp/tmux" },
				tmuxAvailable: false,
			},
			{
				name: "direct launch policy",
				parsed: args({ messages: ["hello world"] }),
				env: { TMUX: "/tmp/tmux", SKC_LAUNCH_POLICY: "direct" },
				tmuxAvailable: true,
			},
		];

		for (const testCase of cases) {
			const calls: Array<{ command: string; args: string[] }> = [];
			const handled = launchDefaultTmuxIfNeeded({
				parsed: testCase.parsed,
				rawArgs: ["hello world"],
				cwd: "/repo",
				env: testCase.env,
				argv: ["/usr/local/bin/skc"],
				execPath: "/bin/bun",
				platform: "darwin",
				tty: interactiveTty,
				tmuxAvailable: testCase.tmuxAvailable,
				currentBranch: "feature/demo",
				spawnSync: (command, spawnArgs) => {
					calls.push({ command, args: spawnArgs });
					return { exitCode: 0 };
				},
			});

			expect(handled, testCase.name).toBe(false);
			expect(calls, testCase.name).toEqual([]);
		}
	});

	it("renames managed tmux windows after creating the session", () => {
		const calls: Array<{ command: string; args: string[]; options: TmuxSpawnOptions }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const newSessionIndex = calls.findIndex(call => call.args[0] === "new-session");
		const renameIndex = calls.findIndex(call => call.args[0] === "rename-window");
		const sessionName = calls[newSessionIndex]?.args[3] ?? "";

		expect(newSessionIndex).toBeGreaterThanOrEqual(0);
		expect(renameIndex).toBeGreaterThan(newSessionIndex);
		expect(calls[renameIndex]?.args).toEqual(["rename-window", "-t", `=${sessionName}`, "--", "repo-feature/demo"]);
	});
	it("falls through to direct launch when session creation fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 1 };
			},
		});

		expect(handled).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0].args[0]).toBe("new-session");
	});

	it("handles and reports partial launch when required profile tagging fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs.includes("@skc-profile")) return { exitCode: 1, stderr: "no server running on /tmp/tmux" };
				// Real tmux answers this; a stub that does not is not modelling tmux.
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$3\t7777\t1700000000\n" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		// Cleanup is now proven and atomic: one invocation both checks and kills.
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: profile tagging failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("continues root launch when non-ownership metadata tagging fails", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: "issue-882",
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs.includes("@skc-branch")) return { exitCode: 1, stderr: "psmux: connection timed out" };
				if (spawnArgs[0] === "attach-session") return { exitCode: 0 };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.map(call => call.args)).toContainEqual([
			"set-option",
			"-t",
			expect.any(String),
			"@skc-profile",
			"1",
		]);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(diagnostics).toEqual([]);
	});

	it("handles and reports partial launch when attach fails after profile succeeds", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				// Real tmux answers this; a stub that does not is not modelling tmux.
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$3\t7777\t1700000000\n" };
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		// Cleanup is now proven and atomic: one invocation both checks and kills.
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: attach failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("preserves a newly created managed session when attach reports SSH disconnect EIO", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session")
					return { exitCode: 1, stderr: "write /dev/tty: input/output error (EIO)" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: attach disconnected.");
	});

	it("does not throw when reporting attach disconnect EIO to closed stderr", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw stderrError("EIO");
		});

		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed: EIO" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, expect.stringContaining("attach disconnected"));
	});

	it("preserves a newly created managed session when attach receives SIGHUP", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session") return { exitCode: null, signalCode: "SIGHUP" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: attach disconnected.");
	});

	it("does not throw when the default tmux diagnostic write hits a closed stderr", () => {
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
			throw stderrError("EIO");
		});

		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (_command, spawnArgs) => {
				// Real tmux answers this; a stub that does not is not modelling tmux.
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$3\t7777\t1700000000\n" };
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writeSpy).toHaveBeenCalledWith(process.stderr.fd, expect.stringContaining("attach failed"));
	});

	it("falls through to direct launch with a diagnostic when tmux is unavailable", () => {
		const diagnostics: string[] = [];
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "/repo",
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: false,
			diagnosticWriter: message => diagnostics.push(message),
		});

		expect(plan).toBeUndefined();
		expect(diagnostics).toEqual([
			"skc --tmux requested but no tmux executable was found; starting without a tmux-backed session.\n",
		]);
	});

	it("explains the psmux install path when no tmux binary is found on native Windows", () => {
		// The legacy diagnostic pointed users at WSL and warned that psmux was
		// "not fully supported". With psmux detected as a supported Windows
		// multiplexer, the diagnostic now recommends installing psmux directly.
		const diagnostics: string[] = [];
		const plan = buildDefaultTmuxLaunchPlan({
			parsed: args({ tmux: true }),
			rawArgs: [],
			cwd: "C:\\repo",
			env: {},
			argv: ["C:\\Program Files\\SKC\\skc.exe"],
			execPath: "C:\\Program Files\\SKC\\skc.exe",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: false,
			diagnosticWriter: message => diagnostics.push(message),
		});

		expect(plan).toBeUndefined();
		expect(diagnostics[0]).toContain("native Windows");
		expect(diagnostics[0]).toContain("psmux");
		expect(diagnostics[0]).toContain("https://github.com/psmux/psmux");
		expect(diagnostics[0]).toContain("SKC_TMUX_COMMAND");
	});

	it("applies session-scoped mouse scrolling when launching tmux on WSL/Linux", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { WSL_DISTRO_NAME: "Ubuntu" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const created = calls.find(call => call.args[0] === "new-session");
		expect(created).toBeDefined();
		const sessionName = created?.args[3] ?? "";
		expect(sessionName.startsWith(SKC_TMUX_SESSION_PREFIX)).toBe(true);
		// The SKC-launched tmux/profile path must not bypass mouse scrolling on WSL.
		expect(calls.some(call => call.command === "tmux")).toBe(true);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "mouse", "on"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@skc-version", VERSION]);
		// All profile mutations stay scoped to the SKC session, never global tmux state.
		expect(calls.flatMap(call => call.args)).not.toContain("-g");
	});

	it("honors SKC_MOUSE=off on WSL/Linux without disabling the rest of the profile", () => {
		const calls: { command: string; args: string[]; options: TmuxSpawnOptions }[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello world"], tmux: true }),
			rawArgs: ["--tmux", "hello world"],
			cwd: "/repo",
			env: { WSL_DISTRO_NAME: "Ubuntu", SKC_MOUSE: "off" },
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "linux",
			tty: interactiveTty,
			tmuxAvailable: true,
			currentBranch: "",
			existingBranchSessionName: null,
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		const created = calls.find(call => call.args[0] === "new-session");
		const sessionName = created?.args[3] ?? "";
		expect(calls.flatMap(call => call.args)).not.toContain("mouse");
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@skc-profile", "1"]);
		expect(calls.map(call => call.args)).toContainEqual(["set-option", "-t", sessionName, "@skc-version", VERSION]);
	});
});

it("emits a UTF-16LE BOM and a script-block &-invocation for native Windows --tmux plans", () => {
	// Regression: skc --tmux on native Windows + psmux previously failed with
	// "attach failed: no server running" because the inner PowerShell-encoded
	// command lacked a UTF-16LE BOM (pwsh rejected it with a parse error) and
	// the trailing `-NoLogo -NoProfile -ExecutionPolicy Bypass` flags were
	// being forwarded into the resolved skc binary instead of being absorbed
	// by PowerShell. Both root causes are fixed by:
	//   1. Prepending a UTF-16LE BOM (0xFF 0xFE) to the encoded buffer.
	//   2. Wrapping the `& <command> <args>` invocation in a script block
	//      `& { ... }` so the trailing flags do not reach the runtime binary.
	const plan = buildDefaultTmuxLaunchPlan({
		parsed: args({ messages: [], tmux: true }),
		rawArgs: ["--tmux"],
		cwd: "C:\\repo",
		env: {},
		argv: ["C:\\Program Files\\SKC\\skc.exe"],
		execPath: "C:\\Program Files\\SKC\\skc.exe",
		platform: "win32",
		tty: interactiveTty,
		tmuxAvailable: true,
		currentBranch: "",
		existingBranchSessionName: null,
	});
	expect(plan).toBeDefined();
	if (!plan) throw new Error("expected tmux plan for win32 --tmux launch");
	const encodedMatch = plan.innerCommand.match(/-EncodedCommand\s+(\S+)/);
	expect(encodedMatch).not.toBeNull();
	if (!encodedMatch) throw new Error("expected -EncodedCommand in inner command");
	const decoded = Buffer.from(encodedMatch[1], "base64");
	// The first two bytes of the decoded buffer must be the UTF-16LE BOM
	// (0xFF 0xFE) so PowerShell -EncodedCommand parses the script correctly.
	expect(decoded[0]).toBe(0xff);
	expect(decoded[1]).toBe(0xfe);
	const script = decoded.subarray(2).toString("utf16le");
	// The inner invocation must be wrapped in a script block so the trailing
	// PowerShell exec-policy flags from the outer invocation are not
	// forwarded into the resolved skc binary itself.
	expect(script).toContain("& {");
	expect(script).toContain("}");
	// No bare `& '<flag>'` invocation should leak into the inner script,
	// because that is what previously made pwsh reject the encoded command.
	expect(script).not.toMatch(/&\s+'-{1,2}[A-Za-z]/);
});

describe("default launch identity create fence", () => {
	// The fence database lives under the agent dir; isolate it so these tests
	// never write into the developer's real ~/.skc.
	const originalAgentDir = process.env.SKC_CODING_AGENT_DIR;
	beforeEach(() => {
		const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "skc-fence-agent-"));
		fenceAgentRoots.push(isolated);
		setAgentDir(path.join(isolated, "agent"));
	});
	const fenceAgentRoots: string[] = [];

	const fenceDirs: string[] = [];

	function fenceEnv(overrides: Record<string, string> = {}): {
		env: Record<string, string>;
		stateDir: string;
		stateFile: string;
		sessionId: string;
		lockDatabase: string;
	} {
		const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skc-launch-fence-")));
		fenceDirs.push(stateDir);
		const sessionId = "launch-coordinator-1";
		const stateFile = path.join(stateDir, "runtime-state.json");
		fs.writeFileSync(stateFile, "{}\n");
		return {
			stateDir,
			stateFile,
			sessionId,
			lockDatabase: path.join(stateDir, sessionId, "owner-lifecycle", "owner-locks.sqlite"),
			env: {
				SKC_COORDINATOR_SESSION_ID: sessionId,
				SKC_COORDINATOR_SESSION_STATE_FILE: stateFile,
				...overrides,
			},
		};
	}

	afterEach(() => {
		__setOwnerIncarnationReaderForTests(null);
		if (originalAgentDir) setAgentDir(originalAgentDir);
		for (const dir of fenceAgentRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
		for (const dir of fenceDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("serializes a non-psmux default created launch with a restore-shaped contender", () => {
		const { env, stateDir, stateFile, sessionId } = fenceEnv({ SKC_PSMUX_DETECTION: "off" });
		__setOwnerIncarnationReaderForTests(() => "darwin:1700000000:515151");

		// A restore-shaped contender owns the identity. It is this process, so the
		// production liveness probe sees a genuinely live owner.
		const contender = reserveIdentityCreate(
			{ stateDir, sessionId, stateFile },
			{ ownerPid: process.pid, ownerIncarnation: "darwin:1700000000:515151" },
		);
		expect(contender.ok).toBe(true);
		if (!contender.ok) return;

		const calls: Array<{ command: string; args: string[] }> = [];
		const diagnostics: string[] = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: stateDir,
			env,
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			diagnosticWriter: message => {
				diagnostics.push(message);
			},
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		// The loser performs no tmux mutation at all: no new-session, no
		// attach-session, no kill-session.
		expect(handled).toBe(true);
		expect(calls).toEqual([]);
		expect(diagnostics.join("\n")).toContain("identity_reserved_live");

		releaseIdentityCreate(contender.reservation);
	});

	it("kills the created session by immutable native id, not by its reusable name", () => {
		const { env } = fenceEnv({ SKC_PSMUX_DETECTION: "off" });
		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: "/repo",
			env,
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$7\t4242\t1700000000\n" };
				// Force the attach to fail so the cleanup path runs.
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach refused" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		// Check and kill must be ONE tmux invocation: a separate check leaves a
		// window for the target to be swapped. A bare kill-session by name is
		// exactly the unsafe shape this replaces.
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		const guarded = calls.find(call => call.args[0] === "if-shell");
		expect(guarded).toBeDefined();
		expect(guarded?.args).toEqual([
			"if-shell",
			"-t",
			"$7",
			"-F",
			"#{&&:#{==:#{pid},4242},#{&&:#{==:#{session_id},$7},#{==:#{session_created},1700000000}}}",
			"kill-session -t $7",
		]);
	});

	// These prove the DURABLE consequence, not just which commands ran: after an
	// unproven cleanup the reservation row must survive, and after a proven one it
	// must be gone. A later owner sees exactly that difference.
	function launchThenProbeReservation(
		hasSession: () => { exitCode: number | null; stderr?: string; signalCode?: string },
	): { env: Record<string, string>; stateDir: string; stateFile: string; sessionId: string } {
		const fixture = fenceEnv({ SKC_PSMUX_DETECTION: "off" });
		launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: fixture.stateDir,
			env: fixture.env,
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "display-message") return { exitCode: 0, stdout: "$7\t4242\t1700000000\n" };
				if (spawnArgs[0] === "has-session") return hasSession();
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach refused" };
				return { exitCode: 0 };
			},
		});
		return fixture;
	}

	it("keeps the reservation when the cleanup probe cannot answer", () => {
		// The probe was killed by a signal, so removal is unproven.
		const fixture = launchThenProbeReservation(() => ({ exitCode: null, signalCode: "SIGKILL" }));
		__setOwnerIncarnationReaderForTests(() => "darwin:1700000000:909090");
		const successor = reserveIdentityCreate(
			{ stateDir: fixture.stateDir, sessionId: fixture.sessionId, stateFile: fixture.stateFile },
			{ ownerPid: 4242001, ownerIncarnation: "darwin:1700000000:909090", probeLiveness: () => "dead" },
		);
		// The row survived, so a successor must resolve it instead of creating.
		expect(successor.ok).toBe(false);
		if (successor.ok) return;
		expect(successor.code).toBe("identity_orphan_unresolved");
		expect(successor.existing?.attemptSessionName).toBeTruthy();
	});

	it("keeps the reservation when the probe fails for an operational reason", () => {
		// Non-zero, but tmux never said the session is absent.
		const fixture = launchThenProbeReservation(() => ({
			exitCode: 1,
			stderr: "error connecting to /tmp/tmux-501/default (Permission denied)",
		}));
		__setOwnerIncarnationReaderForTests(() => "darwin:1700000000:909091");
		const successor = reserveIdentityCreate(
			{ stateDir: fixture.stateDir, sessionId: fixture.sessionId, stateFile: fixture.stateFile },
			{ ownerPid: 4242002, ownerIncarnation: "darwin:1700000000:909091", probeLiveness: () => "dead" },
		);
		expect(successor.ok).toBe(false);
		if (successor.ok) return;
		expect(successor.code).toBe("identity_orphan_unresolved");
	});

	it("releases the reservation once tmux confirms the session is gone", () => {
		const fixture = launchThenProbeReservation(() => ({
			exitCode: 1,
			stderr: "can't find session: $7",
		}));
		__setOwnerIncarnationReaderForTests(() => "darwin:1700000000:909092");
		const successor = reserveIdentityCreate(
			{ stateDir: fixture.stateDir, sessionId: fixture.sessionId, stateFile: fixture.stateFile },
			{ ownerPid: 4242003, ownerIncarnation: "darwin:1700000000:909092", probeLiveness: () => "dead" },
		);
		// Removal was proven, so nothing blocks the next creator.
		expect(successor.ok).toBe(true);
	});

	it("refuses cleanup entirely when the immutable identity cannot be captured", () => {
		const { env } = fenceEnv({ SKC_PSMUX_DETECTION: "off" });
		const calls: Array<{ command: string; args: string[] }> = [];
		launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: "/repo",
			env,
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				// The provider cannot report the session id.
				if (spawnArgs[0] === "display-message") return { exitCode: 1 };
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach refused" };
				return { exitCode: 0 };
			},
		});

		// Leaking a session is recoverable; killing an unrelated one is not. With no
		// proof of what we would kill, nothing is killed — and never by name.
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(calls.some(call => call.args[0] === "if-shell")).toBe(false);
	});

	it("keeps resolved psmux default creation outside the native-proof create fence", () => {
		const { env, lockDatabase } = fenceEnv({ SKC_TMUX_COMMAND: "psmux", SKC_PSMUX_COMMAND: "psmux" });

		const calls: Array<{ command: string; args: string[] }> = [];
		const handled = launchDefaultTmuxIfNeeded({
			parsed: args({ messages: ["hello"], tmux: true }),
			rawArgs: ["--tmux", "hello"],
			cwd: "/repo",
			env,
			argv: ["bun", "packages/coding-agent/src/cli.ts"],
			execPath: "/bin/bun",
			platform: "win32",
			tty: interactiveTty,
			tmuxAvailable: true,
			existingBranchSessionName: null,
			currentBranch: null,
			spawnSync: (command, spawnArgs) => {
				calls.push({ command, args: spawnArgs });
				return { exitCode: 0 };
			},
		});

		// psmux has no immutable native session identity, so the carveout must not
		// touch the native-proof fence at all — not even to create its database.
		expect(handled).toBe(true);
		expect(fs.existsSync(lockDatabase)).toBe(false);
		// Existing psmux launch behavior is untouched.
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
	});
});
