import { Command } from "@sayknow-cli/utils/cli";
import {
	isUltragoalCreateGoalsInvocation,
	readUltragoalSkcObjective,
	SKC_SESSION_FILE_ENV,
	SKC_SESSION_ID_ENV,
	writeCurrentSessionGoalModeState,
	writePendingGoalModeRequest,
} from "../skc-runtime/goal-mode-request";
import { runNativeUltragoalCommand } from "../skc-runtime/ultragoal-runtime";

export default class Ultragoal extends Command {
	static description = "Run native SKC Ultragoal workflow commands";
	static strict = false;
	static examples = ["$ skc ultragoal status --json"];
	static delegateHelp = true;

	async run(): Promise<void> {
		const isReviewStart = this.argv.includes("review") && this.argv.includes("review-start");
		const shouldActivateGoalMode = isUltragoalCreateGoalsInvocation(this.argv);
		const result = await runNativeUltragoalCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
		if (result.status !== 0 || (!shouldActivateGoalMode && !isReviewStart)) return;
		if (isReviewStart && !result.createdReviewPlan && (result.reviewBlockerGoalIds?.length ?? 0) === 0) return;

		const cwd = process.cwd();
		const { objective, goalsPath } = await readUltragoalSkcObjective(cwd);
		await writeCurrentSessionGoalModeState({
			sessionFile: process.env[SKC_SESSION_FILE_ENV],
			objective,
		});
		await writePendingGoalModeRequest({
			cwd,
			objective,
			goalsPath,
			sessionId: process.env[SKC_SESSION_ID_ENV],
		});
	}
}
