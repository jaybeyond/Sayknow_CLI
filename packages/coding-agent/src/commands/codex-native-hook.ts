import { Command } from "@sayknow-cli/utils/cli";
import { runSkcNativeSkillHookCli } from "../hooks/native-skill-hook";

export default class CodexNativeHook extends Command {
	static description = "Run SKC native UserPromptSubmit/Stop skill-state hook";
	static strict = false;

	async run(): Promise<void> {
		await runSkcNativeSkillHookCli();
	}
}
