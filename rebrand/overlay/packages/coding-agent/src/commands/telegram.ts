/**
 * `skc telegram` — manage the Telegram Remote integration.
 */
import { Args, Command, Flags, renderCommandHelp } from "@sayknow-cli/utils/cli";
import {
	runTelegramCommand,
	TELEGRAM_ACTIONS,
	type TelegramAction,
	type TelegramCommandArgs,
} from "../cli/telegram-cli";
import { initTheme } from "../modes/theme/theme";

export default class Telegram extends Command {
	static description = "Manage the Telegram Remote integration (start/status/env)";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...TELEGRAM_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (status)" }),
	};

	static examples = [
		"# Start the Telegram gateway with current settings\n  skc telegram start",
		"# Show integration status\n  skc telegram status",
		"# Show the env vars the gateway would receive\n  skc telegram env",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Telegram);
		if (!args.action) {
			renderCommandHelp("skc", "telegram", Telegram);
			return;
		}
		const cmd: TelegramCommandArgs = {
			action: args.action as TelegramAction,
			flags: { json: flags.json },
		};
		await initTheme();
		await runTelegramCommand(cmd);
	}
}
