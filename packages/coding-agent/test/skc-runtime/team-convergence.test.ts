import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runNativeStateCommand } from "../../src/skc-runtime/state-runtime";
import { monitorSkcTeam, persistSkcTeamModeStateSummary, startSkcTeam } from "../../src/skc-runtime/team-runtime";

let cleanupRoot: string | undefined;

afterEach(async () => {
	if (!cleanupRoot) return;
	await fs.rm(cleanupRoot, { recursive: true, force: true });
	cleanupRoot = undefined;
});

describe("native skc team mode-state convergence", () => {
	it("keeps skc state team read aligned with dry-run team start and status snapshots", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skc-team-convergence-"));
		const started = await startSkcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Converge team state",
			teamName: "converge-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});
		await persistSkcTeamModeStateSummary(started, cleanupRoot);

		const startRead = await runNativeStateCommand(
			["read", "--mode", "team", "--session-id", "", "--json"],
			cleanupRoot,
		);
		expect(startRead.status).toBe(0);
		const startState = JSON.parse(startRead.stdout ?? "{}");
		expect(startState.state.current_phase).toBe(started.phase);
		expect(startState.state.team_name).toBe(started.team_name);
		expect(startState.state.task_counts).toEqual(started.task_counts);

		const status = await monitorSkcTeam(started.team_name, cleanupRoot, { PATH: "" });
		await persistSkcTeamModeStateSummary(status, cleanupRoot);

		const statusRead = await runNativeStateCommand(
			["read", "--mode", "team", "--session-id", "", "--json"],
			cleanupRoot,
		);
		expect(statusRead.status).toBe(0);
		const statusState = JSON.parse(statusRead.stdout ?? "{}");
		expect(statusState.state.current_phase).toBe(status.phase);
		expect(statusState.state.team_name).toBe(status.team_name);
		expect(statusState.state.task_counts).toEqual(status.task_counts);
		expect(statusState.state.active).toBe(true);
		expect(statusState.state.receipt.owner).toBe("skc-runtime");
	});
});
