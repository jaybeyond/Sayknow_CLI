import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { GcContext } from "@sayknow-cli/coding-agent/skc-runtime/gc-runtime";
import { tmuxSessionsGcAdapter } from "@sayknow-cli/coding-agent/skc-runtime/tmux-gc";

const env = { SKC_TMUX_COMMAND: "tmux-test" };
const project = "/tmp/skc-project";

type SpawnSyncResult = Bun.SyncSubprocess<"pipe", "pipe">;
type SpawnSyncSpy = { mockImplementation(implementation: (command: string[]) => SpawnSyncResult): void };

function spawnResult(exitCode: number, stdout: string, stderr = ""): SpawnSyncResult {
	return {
		exitCode,
		stdout: Buffer.from(stdout),
		stderr: Buffer.from(stderr),
	} as SpawnSyncResult;
}

function ctx(): GcContext {
	return {
		probe: () => ({ status: "dead" }),
		force: false,
		env,
		cwd: project,
	};
}

function sessionLine(overrides: {
	name: string;
	attached?: boolean;
	created?: number;
	profile?: string;
	panes?: number;
	panePid?: number;
	branch?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
}): string {
	return [
		overrides.name,
		"1",
		overrides.attached ? "1" : "0",
		String(overrides.created ?? 1_770_000_000),
		overrides.profile ?? "1",
		"root",
		String(overrides.panes ?? (overrides.panePid ? 1 : 0)),
		overrides.panePid ? String(overrides.panePid) : "",
		overrides.branch ?? "",
		overrides.branch?.replaceAll("/", "-") ?? "",
		overrides.project ?? "",
		overrides.sessionId ?? "",
		overrides.sessionStateFile ?? "",
	].join("\t");
}

describe("tmux GC safety", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("classifies attached/live tagged sessions with stale metadata as non-removable and does not prune", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		spyOn(Bun, "spawnSync").mockReturnValue(
			spawnResult(0, sessionLine({ name: "sayknow_cli_live", attached: true, branch: "stale", project })),
		);

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "sayknow_cli_live");

		expect(result.errors).toEqual([]);
		expect(record).toMatchObject({ status: "live", stale: false, removable: false, pid_status: "alive" });
		expect(record?.reason).toBe("tmux_session_attached_or_has_live_panes");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(Bun.spawnSync).not.toHaveBeenCalledWith(
			["tmux-test", "kill-session", "-t", "=sayknow_cli_live"],
			expect.any(Object),
		);
	});

	it("keeps markerless metadata-less SKC-owned idle orphans non-removable", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_orphan\nunrelated_orphan\n");
				return spawnResult(
					0,
					[
						sessionLine({ name: "sayknow_cli_orphan", profile: "1", created: 1_770_000_000 }),
						sessionLine({ name: "unrelated_orphan", profile: "", created: 1_770_000_000 }),
					].join("\n"),
				);
			}
			if (cmd.includes("show-options")) return spawnResult(0, cmd.at(-1) === "@skc-profile" ? "1\n" : "\n");
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const orphan = result.records.find(entry => entry.id === "sayknow_cli_orphan");
		const unrelated = result.records.find(entry => entry.id === "unrelated_orphan");

		expect(orphan).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "metadata_less_skc_owned_idle_orphan_missing_terminal_marker",
		});
		expect(unrelated).toMatchObject({ status: "unclassified", removable: false, reason: "untagged_tmux_session" });
		expect(await tmuxSessionsGcAdapter.prune(orphan!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_orphan"]);
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=unrelated_orphan"]);
	});

	it("prunes detached pane-less sessions only when their runtime marker is terminal", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/skc-terminal-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({ schema_version: 1, session_id: "session-1", state: "completed", cwd: project }),
		);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_done\n");
				return spawnResult(
					0,
					sessionLine({
						name: "sayknow_cli_done",
						branch: "main",
						project,
						sessionId: "session-1",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@skc-profile") return spawnResult(0, "1\n");
				if (option === "@skc-project") return spawnResult(0, `${project}\n`);
				if (option === "@skc-branch") return spawnResult(0, "main\n");
				if (option === "@skc-session-id") return spawnResult(0, "session-1\n");
				if (option === "@skc-session-state-file") return spawnResult(0, `${stateFile}\n`);
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "sayknow_cli_done");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({ removed: true });
			expect(calls).toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_done"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("keeps stale project or branch metadata non-removable without a terminal marker", async () => {
		const missingProject = "/tmp/skc-missing-project";
		const nonRepoProject = "/tmp";
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}")
					return spawnResult(0, "sayknow_cli_missing_project\nsayknow_cli_no_worktree\n");
				return spawnResult(
					0,
					[
						sessionLine({ name: "sayknow_cli_missing_project", branch: "main", project: missingProject }),
						sessionLine({
							name: "sayknow_cli_no_worktree",
							branch: "definitely-missing-skc-branch",
							project: nonRepoProject,
						}),
					].join("\n"),
				);
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const missing = result.records.find(entry => entry.id === "sayknow_cli_missing_project");
		const noWorktree = result.records.find(entry => entry.id === "sayknow_cli_no_worktree");

		expect(missing).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "project_missing_without_terminal_marker",
		});
		expect(noWorktree).toMatchObject({
			status: "unclassified",
			removable: false,
			reason: "branch_no_worktree_without_terminal_marker",
		});
		expect(await tmuxSessionsGcAdapter.prune(missing!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(await tmuxSessionsGcAdapter.prune(noWorktree!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_missing_project"]);
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_no_worktree"]);
	});

	it("keeps attached sessions non-removable even when their runtime marker is terminal", async () => {
		const stateFile = "/tmp/skc-terminal-attached-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({ schema_version: 1, session_id: "session-1", state: "completed", cwd: project }),
		);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_attached_done\n");
				return spawnResult(
					0,
					sessionLine({
						name: "sayknow_cli_attached_done",
						attached: true,
						branch: "main",
						project,
						sessionId: "session-1",
						sessionStateFile: stateFile,
					}),
				);
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "sayknow_cli_attached_done");

			expect(record).toMatchObject({
				status: "live",
				removable: false,
				reason: "tmux_session_attached_or_has_live_panes",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
				removed: false,
				skipped: "not_removable_tmux_session",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_attached_done"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("revalidation skips kill when a removable session becomes attached before prune", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/skc-terminal-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "race-session",
				state: "completed",
				cwd: "/tmp/missing-skc-project",
			}),
		);
		const calls: string[][] = [];
		let listCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_race\n");
				listCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "sayknow_cli_race",
						attached: listCount > 1,
						branch: "stale",
						project: "/tmp/missing-skc-project",
						sessionId: "race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@skc-profile") return spawnResult(0, "1\n");
				if (option === "@skc-project") return spawnResult(0, "/tmp/missing-skc-project\n");
				if (option === "@skc-branch") return spawnResult(0, "stale\n");
				if (option === "@skc-session-id") return spawnResult(0, "race-session\n");
				if (option === "@skc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "sayknow_cli_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
				removed: false,
				skipped: "tmux_revalidation_failed_or_became_live",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("final status read blocks kill when a revalidated candidate becomes attached", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/skc-terminal-final-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "final-race-session",
				state: "completed",
				cwd: "/tmp/missing-skc-project",
			}),
		);
		const calls: string[][] = [];
		let richListCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_final_race\n");
				richListCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "sayknow_cli_final_race",
						attached: richListCount > 2,
						branch: "stale",
						project: "/tmp/missing-skc-project",
						sessionId: "final-race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@skc-profile") return spawnResult(0, "1\n");
				if (option === "@skc-project") return spawnResult(0, "/tmp/missing-skc-project\n");
				if (option === "@skc-branch") return spawnResult(0, "stale\n");
				if (option === "@skc-session-id") return spawnResult(0, "final-race-session\n");
				if (option === "@skc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "sayknow_cli_final_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
				removed: false,
				error: "skc_tmux_session_live:sayknow_cli_final_race",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_final_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("final status read blocks kill when a detached revalidated candidate has live pane PIDs", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const stateFile = "/tmp/skc-terminal-final-pane-race-marker.json";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "final-pane-race-session",
				state: "completed",
				cwd: "/tmp/missing-skc-project",
			}),
		);
		const calls: string[][] = [];
		let richListCount = 0;
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_final_pane_race\n");
				richListCount += 1;
				return spawnResult(
					0,
					sessionLine({
						name: "sayknow_cli_final_pane_race",
						attached: false,
						panePid: richListCount > 2 ? 43210 : undefined,
						branch: "stale",
						project: "/tmp/missing-skc-project",
						sessionId: "final-pane-race-session",
						sessionStateFile: stateFile,
					}),
				);
			}
			if (cmd.includes("show-options")) {
				const option = cmd.at(-1);
				if (option === "@skc-profile") return spawnResult(0, "1\n");
				if (option === "@skc-project") return spawnResult(0, "/tmp/missing-skc-project\n");
				if (option === "@skc-branch") return spawnResult(0, "stale\n");
				if (option === "@skc-session-id") return spawnResult(0, "final-pane-race-session\n");
				if (option === "@skc-session-state-file") return spawnResult(0, `${stateFile}\n`);
				return spawnResult(0, "\n");
			}
			return spawnResult(0, "");
		});

		try {
			const result = await tmuxSessionsGcAdapter.collect(ctx());
			const record = result.records.find(entry => entry.id === "sayknow_cli_final_pane_race");

			expect(record).toMatchObject({
				status: "stale",
				removable: true,
				reason: "terminal_runtime_marker_detached_idle_session",
			});
			expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toMatchObject({
				removed: false,
				error: "skc_tmux_session_live:sayknow_cli_final_pane_race",
			});
			expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_final_pane_race"]);
		} finally {
			await fs.rm(stateFile, { force: true });
		}
	});

	it("keeps old detached prefix-named untagged sessions non-removable", async () => {
		spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const calls: string[][] = [];
		const spawnSyncSpy = spyOn(Bun, "spawnSync") as unknown as SpawnSyncSpy;
		spawnSyncSpy.mockImplementation((cmd: string[]) => {
			calls.push(cmd);
			if (cmd.includes("list-sessions")) {
				const format = cmd[cmd.indexOf("-F") + 1] ?? "";
				if (format === "#{session_name}") return spawnResult(0, "sayknow_cli_user_owned\n");
				return spawnResult(0, sessionLine({ name: "sayknow_cli_user_owned", profile: "", created: 1_600_000_000 }));
			}
			return spawnResult(0, "");
		});

		const result = await tmuxSessionsGcAdapter.collect(ctx());
		const record = result.records.find(entry => entry.id === "sayknow_cli_user_owned");

		expect(record).toMatchObject({ status: "unclassified", stale: false, removable: false });
		expect(record?.reason).toBe("untagged_tmux_session");
		expect(await tmuxSessionsGcAdapter.prune(record!, ctx())).toEqual({
			removed: false,
			skipped: "not_removable_tmux_session",
		});
		expect(calls).not.toContainEqual(["tmux-test", "kill-session", "-t", "=sayknow_cli_user_owned"]);
	});
});
