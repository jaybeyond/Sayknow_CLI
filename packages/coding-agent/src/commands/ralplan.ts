import { Command } from "@sayknow-cli/utils/cli";
import { runNativeRalplanCommand } from "../skc-runtime/ralplan-runtime";

export default class Ralplan extends Command {
	static description = "Run native SKC RALPLAN consensus planning workflow";
	static strict = false;
	static examples = [
		'$ skc ralplan "<task description>"',
		'$ skc ralplan --interactive --deliberate "<task description>"',
		'$ skc ralplan --write --stage planner --stage_n 1 --artifact "<markdown or path>"',
	];

	async run(): Promise<void> {
		const result = await runNativeRalplanCommand(this.argv, process.cwd());
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
