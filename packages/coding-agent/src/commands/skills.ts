/**
 * Inspect bundled workflow skills.
 */
import { Args, Command, Flags, renderCommandHelp } from "@sayknow-cli/utils/cli";
import { runSkillsCommand, type SkillsAction, type SkillsCommandArgs } from "../cli/skills-cli";

const ACTIONS: SkillsAction[] = ["list", "read"];

export default class Skills extends Command {
	static description = "Inspect bundled SKC workflow skills";

	static args = {
		action: Args.string({
			description: "Skills action",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Bundled skill name to read",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"# List bundled workflow skills\n  skc skills list",
		"# Read an embedded workflow skill without requiring .skc files\n  skc skills read ultragoal",
		"# Machine-readable embedded skill content\n  skc skills read ralplan --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skills);
		if (!args.action) {
			renderCommandHelp("skc", "skills", Skills);
			return;
		}

		const cmd: SkillsCommandArgs = {
			action: args.action as SkillsAction,
			name: args.name,
			flags: { json: flags.json },
		};
		await runSkillsCommand(cmd);
	}
}
