import { Command } from "@sayknow-cli/utils/cli";
import { runNativeRalplanCommand } from "../skc-runtime/ralplan-runtime";

export default class Ralplan extends Command {
	static description = "Run Blueprint, SKC's consensus planning workflow";
	static strict = false;
	static examples = [
		'$ skc blueprint "<task description>"',
		'$ skc blueprint --interactive --deliberate "<task description>"',
		'$ skc blueprint --write --stage planner --stage_n 1 --artifact "<markdown or path>"',
		"$ skc blueprint --write --stage critic --stage_n 1 --artifact-env SKC_RALPLAN_ARTIFACT",
	];

	async run(): Promise<void> {
		const result = await runNativeRalplanCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
