import { afterEach, describe, expect, it } from "bun:test";
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

function args(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		...overrides,
	};
}

const interactiveTty = { stdin: true, stdout: true };
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function stderrError(code: string): Error {
	const error = new Error(`${code} from stderr`);
	Object.defineProperty(error, "code", { value: code });
	return error;
}

describe("default SKC tmux launch", () => {
	afterEach(() => {
		process.stderr.write = originalStderrWrite;
	});

	it("builds project and branch tmux window titles", () => {
		expect(buildSkcTmuxWindowTitle("/repo", "feature/demo")).toBe("repo:feature/demo");
		expect(buildSkcTmuxWindowTitle("/repo", null)).toBe("repo");
		expect(buildSkcTmuxWindowTitle("/repo", "")).toBe("repo");
	});

	it("truncates long tmux window titles to 48 visible columns while preserving the project and branch tail", () => {
		const title = buildSkcTmuxWindowTitle("/repo", `feature/${"a".repeat(80)}tail`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("repo:…")).toBe(true);
		expect(title.endsWith("tail")).toBe(true);
	});

	it("truncates wide-character tmux window titles by visible width while preserving the branch tail", () => {
		const title = buildSkcTmuxWindowTitle("/저장소", `feature/${"界".repeat(80)}끝`);

		expect(Bun.stringWidth(title)).toBeLessThanOrEqual(48);
		expect(title.startsWith("저장소:…")).toBe(true);
		expect(title.endsWith("끝")).toBe(true);
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
			currentBranch: "feature/demo",
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(false);
		expect(calls[0]?.args).toEqual(["rename-window", "--", "-repo:feature/demo"]);
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
		});

		expect(plan).toBeUndefined();
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
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.sessionName.startsWith(SKC_TMUX_SESSION_PREFIX)).toBe(true);
		expect(plan.tmuxCommand).toBe("tmux");
		expect(plan.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", plan.sessionName, "-c", "/repo"]);
		expect(plan?.innerCommand).toContain(`${SKC_TMUX_LAUNCHED_ENV}=1`);
		expect(plan?.innerCommand).toContain(
			"'/bin/bun' '/repo/packages/coding-agent/src/cli.ts' '--tmux' 'hello world'",
		);
		expect(plan.innerCommand).toContain("SKC_COORDINATOR_SESSION_ID=");
		expect(plan.innerCommand).toContain("SKC_COORDINATOR_SESSION_STATE_FILE=");
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
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");

		expect(plan.innerCommand).not.toContain("$bunfs");
		expect(plan.innerCommand).toContain(`${SKC_TMUX_LAUNCHED_ENV}=1`);
		expect(plan.innerCommand).toContain("'/home/me/.local/bin/skc' '--tmux' 'hello world'");
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
		});

		expect(plan?.innerCommand).not.toContain("$bunfs");
		expect(plan?.innerCommand).toContain("'skc' '--tmux'");
	});

	it("attaches existing tagged session for matching worktree branch", () => {
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
		expect(calls.some(call => call.args[0] === "new-session")).toBe(false);
		expect(calls.at(-1)?.args).toEqual(["attach-session", "-t", "=sayknow_cli_feature"]);
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
		});

		expect(plan?.sessionName).toBe("custom-skc");
		expect(plan?.newSessionArgs.slice(0, 6)).toEqual(["new-session", "-d", "-s", "custom-skc", "-c", "/repo"]);
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
	});

	it("plans matching tmux marker tags and inner process marker env", () => {
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
		});

		expect(plan).toBeDefined();
		if (!plan) throw new Error("expected tmux plan");
		expect(plan.sessionId).toBe(plan.sessionName);
		expect(plan.sessionStateFile).toContain("/repo/.skc/runtime/tmux-sessions/");
		expect(plan.innerCommand).toContain(`SKC_COORDINATOR_SESSION_ID='${plan.sessionId}'`);
		expect(plan.innerCommand).toContain(`SKC_COORDINATOR_SESSION_STATE_FILE='${plan.sessionStateFile}'`);
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
		expect(calls).toHaveLength(4);
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
			args: ["rename-window", "--", "repo:feature/demo"],
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
		expect(calls[renameIndex]?.args).toEqual(["rename-window", "-t", `=${sessionName}`, "--", "repo:feature/demo"]);
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
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs.includes("@skc-profile")) return { exitCode: 1, stderr: "no server running on /tmp/tmux" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: profile tagging failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
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
			diagnosticWriter: message => diagnostics.push(message),
			spawnSync: (command, spawnArgs, options) => {
				calls.push({ command, args: spawnArgs, options });
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(calls.some(call => call.args[0] === "new-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "attach-session")).toBe(true);
		expect(calls.some(call => call.args[0] === "kill-session")).toBe(false);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toStartWith("skc --tmux failed after creating tmux session: attach failed.");
		expect(diagnostics[0].length).toBeLessThan(320);
	});

	it("does not throw when the default tmux diagnostic write hits a closed stderr", () => {
		const writes: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			throw stderrError("EIO");
		}) satisfies typeof process.stderr.write;

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
			spawnSync: (_command, spawnArgs) => {
				if (spawnArgs[0] === "attach-session") return { exitCode: 1, stderr: "attach failed" };
				return { exitCode: 0 };
			},
		});

		expect(handled).toBe(true);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toStartWith("skc --tmux failed after creating tmux session: attach failed.");
	});

	it("falls through to direct launch when tmux is unavailable", () => {
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
		});

		expect(plan).toBeUndefined();
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
	});
});
