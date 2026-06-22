/**
 * Import MCP servers and skills from other coding agents into SKC.
 */
import { Command, Flags } from "@sayknow-cli/utils/cli";
import { type MigrateCommandArgs, runMigrateCommand } from "../cli/migrate-cli";

export default class Migrate extends Command {
	static description = "Import MCP servers and skills from Claude Code, Codex, or OpenCode";

	static examples = [
		"skc migrate --from claude-code",
		"skc migrate --from codex --from opencode",
		"skc migrate --from all --dry-run --json",
		"skc migrate --from claude-code --project --force",
	];

	static flags = {
		from: Flags.string({
			description: "Source agent to import from (repeatable): claude-code | codex | opencode | all",
			multiple: true,
			required: true,
		}),
		project: Flags.boolean({
			description: "Write to the project scope (./.skc) instead of the user scope (~/.skc)",
			default: false,
		}),
		force: Flags.boolean({
			description: "Overwrite existing skills/MCP servers instead of skipping them",
			default: false,
		}),
		"dry-run": Flags.boolean({ description: "Preview the migration without writing anything", default: false }),
		json: Flags.boolean({ char: "j", description: "Emit a machine-readable JSON report", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Migrate);
		const cmd: MigrateCommandArgs = {
			from: flags.from ?? [],
			project: flags.project,
			force: flags.force,
			dryRun: flags["dry-run"],
			json: flags.json,
		};
		await runMigrateCommand(cmd);
	}
}
