import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	__setBinaryResolverForTests,
	clearPsmuxDetectionCache,
} from "@sayknow-cli/coding-agent/skc-runtime/psmux-detect";
import { buildSkcTmuxExactOptionTarget } from "@sayknow-cli/coding-agent/skc-runtime/tmux-common";
import {
	createSkcTmuxSession,
	listSkcTmuxSessions,
	removeSkcTmuxSession,
	statusSkcTmuxSession,
} from "@sayknow-cli/coding-agent/skc-runtime/tmux-sessions";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResult): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

describe("SKC tmux session management", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists only SKC-managed tmux sessions", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(
				0,
				[
					"sayknow_cli_abc	1	0	1770000000	1	root	2	12345	feature/demo	feature-demo	/repo-a",
					"unrelated	2	1	1770000060		root	3	23456		",
					"sayknow_cli	1	1	1770000120		root	1	34567		",
				].join("\n"),
			),
		);

		clearPsmuxDetectionCache();
		const sessions = listSkcTmuxSessions({ SKC_TMUX_COMMAND: "tmux-test" });

		expect(sessions.map(session => session.name)).toEqual(["sayknow_cli_abc"]);
		expect(sessions[0].attached).toBe(false);
		expect(sessions[0].panes).toBe(2);
		expect(sessions[0].panePids).toEqual([12345]);
		expect(sessions[0].bindings).toBe("root");
		expect(sessions[0].createdAt).toBe("2026-02-02T02:40:00.000Z");
		expect(sessions[0].branch).toBe("feature/demo");
		expect(sessions[0].project).toBe("/repo-a");
		expect(Bun.spawnSync).toHaveBeenCalledWith(
			[
				"tmux-test",
				"list-sessions",
				"-F",
				"#{session_name}	#{session_windows}	#{session_attached}	#{session_created}	#{@skc-profile}	#{session_key_table}	#{session_panes}	#{pane_pid}	#{@skc-branch}	#{@skc-branch-slug}	#{@skc-project}	#{@skc-session-id}	#{@skc-session-state-file}	#{@skc-version}",
			],
			expect.any(Object),
		);
	});

	it("returns an empty list when tmux has no server", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(1, "", "no server running on /tmp/tmux"));

		expect(listSkcTmuxSessions()).toEqual([]);
	});

	it("guards status and remove to SKC-managed sessions", () => {
		// Pin the resolved command to tmux so the assertions are agnostic to
		// whether the host has psmux / pmux / tmux on PATH. The shared
		// resolveSkcTmuxCommand now picks the first available multiplexer on
		// Windows; we explicitly opt into literal tmux for this guard test.
		const env = { SKC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		expect(statusSkcTmuxSession("sayknow_cli_work", env).name).toBe("sayknow_cli_work");
		expect(() => statusSkcTmuxSession("unrelated", env)).toThrow("skc_tmux_session_not_found:unrelated");
		expect(removeSkcTmuxSession("sayknow_cli_work", env).name).toBe("sayknow_cli_work");
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=sayknow_cli_work"]);
	});

	it("does not kill when final live profile check fails", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "\n");
			return spawnResult(0, "");
		});

		expect(() => removeSkcTmuxSession("sayknow_cli_work")).toThrow("skc_tmux_session_not_managed:sayknow_cli_work");
		expect(calls.some(call => call.includes("kill-session"))).toBe(false);
	});

	it("diagnoses sessions the multiplexer lists but did not tag with the SKC profile", () => {
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				// The bare `#{session_name}` probe sees the session (psmux ls shows it)...
				if (format === "#{session_name}") return spawnResult(0, "psmux_session\n");
				// ...but the full format does not round-trip @skc-profile, so the profile column is empty.
				return spawnResult(0, "psmux_session	1	0	1770000000		root	0				\n");
			}
			return spawnResult(0, "");
		});

		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(
			"skc_tmux_session_untagged:psmux_session",
		);
		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(
			/cwd\/start-directory flags such as `-c` do not isolate the server namespace/,
		);
		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(
			/SKC_TMUX_COMMAND and SKC_TEAM_TMUX_COMMAND are binary overrides, not shell command lines/,
		);
		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(/not fully supported/);
	});

	it("hydrates native Windows tmux sessions from exact option reads when list-sessions omits user options", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "win_session	1	0	1770000000		root	1	12345					\n");
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@skc-profile") return spawnResult(0, "1\n");
				if (option === "@skc-branch") return spawnResult(0, "issue-882-windows-tmux\n");
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		const session = statusSkcTmuxSession("win_session", { SKC_TMUX_COMMAND: "tmux" });

		expect(session.name).toBe("win_session");
		expect(session.profile).toBe("1");
		expect(session.branch).toBe("issue-882-windows-tmux");
		expect(calls).toContainEqual(["tmux", "show-options", "-qv", "-t", "=win_session:", "@skc-profile"]);
	});

	it("still reports plain not-found when the multiplexer does not list the session", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(0, ""));

		expect(() => statusSkcTmuxSession("ghost")).toThrow("skc_tmux_session_not_found:ghost");
	});

	it("builds a window-qualified exact target for tmux option commands", () => {
		// tmux 3.6a only resolves the exact session for option commands when the
		// target is window-qualified (`=NAME:`); a bare `=NAME` does not (#580).
		expect(buildSkcTmuxExactOptionTarget("sayknow_cli_work")).toBe("=sayknow_cli_work:");
	});

	it("queries the profile option with a window-qualified exact target", () => {
		// Pin the resolved command to tmux so this test is platform-agnostic.
		const env = { SKC_TMUX_COMMAND: "tmux" };
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work	1	0	1770000000	1	root	1			\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		removeSkcTmuxSession("sayknow_cli_work", env);

		const showOptions = calls.find(call => call.includes("show-options"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=sayknow_cli_work:", "@skc-profile"]);
		// Session-scoped commands keep the bare exact target, which tmux resolves.
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=sayknow_cli_work"]);
	});

	it("drops the tmux `=NAME` exact-session prefix on psmux for option commands", () => {
		// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix on
		// set-option / show-options with "no server running on session '=NAME'",
		// but tmux 3.6a needs the window-qualified `=NAME:` to resolve the
		// session for option/display commands. The shared resolver should
		// pick the right shape for the active multiplexer. Use the
		// BinaryResolver test seam + SKC_PSMUX_COMMAND override so the
		// detection layer agrees on the multiplexer identity without
		// needing a real psmux binary on PATH.
		__setBinaryResolverForTests(candidate =>
			candidate === "psmux" || candidate === "pmux" ? `/fake/${candidate}` : null,
		);
		try {
			expect(buildSkcTmuxExactOptionTarget("work", { env: { SKC_TMUX_COMMAND: "tmux" } })).toBe("=work:");
			expect(
				buildSkcTmuxExactOptionTarget("work", { env: { SKC_TMUX_COMMAND: "psmux", SKC_PSMUX_COMMAND: "psmux" } }),
			).toBe("work");
			expect(
				buildSkcTmuxExactOptionTarget("work", { env: { SKC_TMUX_COMMAND: "pmux", SKC_PSMUX_COMMAND: "pmux" } }),
			).toBe("work");
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("hydrates native psmux sessions even when -F is silently ignored", () => {
		// Make the resolver recognize psmux so the list-sessions fallback engages.
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			// psmux 3.3.0 silently ignores the tmux -F format flag and returns its
			// default `name: N windows (created ...)` shape. The list-sessions
			// fallback should detect that, synthesize a tab-separated row, and
			// recover the @skc-profile tag via follow-up show-options calls.
			//
			// psmux show-options returns `key value` (not just `value` like tmux),
			// so the parser must also strip the leading key on psmux.
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				if (cmd.includes("list-sessions")) {
					return spawnResult(0, "psmux_session: 1 windows (created Sat Jun 27 17:00:00 2026)\n");
				}
				if (cmd.includes("show-options")) {
					const option = cmd.at(-1);
					if (option === "@skc-profile") return spawnResult(0, "@skc-profile 1");
					return spawnResult(0, "");
				}
				return spawnResult(0, "");
			});

			const sessions = listSkcTmuxSessions({
				SKC_TMUX_COMMAND: "psmux",
				SKC_PSMUX_COMMAND: "psmux",
			});

			expect(sessions).toHaveLength(1);
			expect(sessions[0].name).toBe("psmux_session");
			expect(sessions[0].profile).toBe("1");
			expect(sessions[0].windows).toBe(1);
			// follow-up show-options hit the bare `NAME` target (no `=` prefix).
			expect(calls).toContainEqual(["psmux", "show-options", "-qv", "-t", "psmux_session", "@skc-profile"]);
		} finally {
			__setBinaryResolverForTests(null);
		}
	});

	it("createSkcTmuxSession drops the psmux UX profile commands", () => {
		__setBinaryResolverForTests(candidate => (candidate === "psmux" ? "/fake/psmux" : null));
		try {
			// psmux does not implement set-window-option (it reports "unknown
			// command: set-window-option") and historically drops mouse /
			// set-clipboard / mode-style on set-option. createSkcTmuxSession must
			// apply the same UX filter that applySkcTmuxProfile already applies
			// for `skc --tmux` planning, otherwise the create flow throws and
			// the new session gets killed by tryKillSession.
			const calls: string[][] = [];
			const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
			spawnSyncSpy.mockImplementation((cmd: string[]) => {
				calls.push(cmd);
				if (cmd[0] === "psmux" && cmd[1] === "new-session") return spawnResult(0, "");
				if (cmd.includes("list-sessions")) {
					return spawnResult(0, "psmux_session: 1 windows (created Sat Jun 27 17:00:00 2026)\n");
				}
				if (cmd.includes("show-options")) return spawnResult(0, "@skc-profile 1");
				return spawnResult(0, "");
			});

			try {
				createSkcTmuxSession({
					SKC_TMUX_COMMAND: "psmux",
					SKC_PSMUX_COMMAND: "psmux",
				} as NodeJS.ProcessEnv);
			} catch {
				// Some CI environments stub the tmux binary; we only assert on the
				// profile command list, not the overall result.
			}

			const setWindowOptionCalls = calls.filter(cmd => cmd[0] === "psmux" && cmd[1] === "set-window-option");
			const setOptionCalls = calls.filter(cmd => cmd[0] === "psmux" && cmd[1] === "set-option");
			// set-window-option must never run on psmux.
			expect(setWindowOptionCalls).toEqual([]);
			// Every psmux set-option call must carry an @skc-* ownership tag, never
			// mouse / set-clipboard / mode-style. The UX profile commands get
			// filtered out by buildSkcTmuxProfileCommands when the active binary
			// is psmux.
			for (const cmd of setOptionCalls) {
				const key = cmd[cmd.length - 2];
				expect([
					"@skc-profile",
					"@skc-branch",
					"@skc-branch-slug",
					"@skc-project",
					"@skc-session-id",
					"@skc-session-state-file",
					"@skc-version",
				]).toContain(key);
			}
		} finally {
			__setBinaryResolverForTests(null);
		}
	});
});
