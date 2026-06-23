import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { buildSkcTmuxExactOptionTarget } from "@sayknow-cli/coding-agent/skc-runtime/tmux-common";
import {
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
					"sayknow_cli_abc\t1\t0\t1770000000\t1\troot\t2\t12345\tfeature/demo\tfeature-demo\t/repo-a",
					"unrelated\t2\t1\t1770000060\t\troot\t3\t23456\t\t",
					"sayknow_cli\t1\t1\t1770000120\t\troot\t1\t34567\t\t",
				].join("\n"),
			),
		);

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
				"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{@skc-profile}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{@skc-branch}\t#{@skc-branch-slug}\t#{@skc-project}\t#{@skc-session-id}\t#{@skc-session-state-file}\t#{@skc-version}",
			],
			expect.any(Object),
		);
	});

	it("returns an empty list when tmux has no server", () => {
		spyOn(Bun, "spawnSync").mockReturnValue(spawnResult(1, "", "no server running on /tmp/tmux"));

		expect(listSkcTmuxSessions()).toEqual([]);
	});

	it("guards status and remove to SKC-managed sessions", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		expect(statusSkcTmuxSession("sayknow_cli_work").name).toBe("sayknow_cli_work");
		expect(() => statusSkcTmuxSession("unrelated")).toThrow("skc_tmux_session_not_found:unrelated");
		expect(removeSkcTmuxSession("sayknow_cli_work").name).toBe("sayknow_cli_work");
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=sayknow_cli_work"]);
	});

	it("does not kill when final live profile check fails", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
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
				return spawnResult(0, "psmux_session\t1\t0\t1770000000\t\troot\t0\t\t\t\t\n");
			}
			return spawnResult(0, "");
		});

		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(
			"skc_tmux_session_untagged:psmux_session",
		);
		expect(() => statusSkcTmuxSession("psmux_session", { SKC_TMUX_COMMAND: "psmux" })).toThrow(/not fully supported/);
	});

	it("hydrates native Windows tmux sessions from exact option reads when list-sessions omits user options", () => {
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "win_session\t1\t0\t1770000000\t\troot\t1\t12345\t\t\t\t\t\n");
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
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				return spawnResult(0, "sayknow_cli_work\t1\t0\t1770000000\t1\troot\t1\t\t\t\n");
			}
			if (cmd.includes("show-options")) return spawnResult(0, "1\n");
			return spawnResult(0, "");
		});

		removeSkcTmuxSession("sayknow_cli_work");

		const showOptions = calls.find(call => call.includes("show-options"));
		expect(showOptions).toEqual(["tmux", "show-options", "-qv", "-t", "=sayknow_cli_work:", "@skc-profile"]);
		// Session-scoped commands keep the bare exact target, which tmux resolves.
		expect(calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=sayknow_cli_work"]);
	});
});
