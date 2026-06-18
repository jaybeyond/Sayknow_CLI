import { Command } from "@sayknow-cli/utils/cli";
import { runNativeStateCommand } from "../skc-runtime/state-runtime";

export default class State extends Command {
	static description = "Read or update SKC workflow state receipts under .skc/state";
	static strict = false;
	static examples = [
		'$ skc state read --input \'{"mode":"deep-interview"}\' --json',
		'$ skc state write --input \'{"state":{"interview_id":"abc"}}\' --mode deep-interview --json',
		"$ skc state clear --mode deep-interview",
		"$ skc state deep-interview read --json",
		'$ skc state ralplan write --input \'{"phase":"planner","active":true}\' --json',
		"$ skc state team contract",
		"$ skc state deep-interview handoff --to ralplan --json",
		"$ skc state doctor --skill ralplan --json",
	];

	async run(): Promise<void> {
		const result = await runNativeStateCommand(this.argv);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
