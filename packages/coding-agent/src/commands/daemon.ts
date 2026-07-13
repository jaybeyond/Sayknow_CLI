/**
 * Manage SKC background daemons (status/list/stop/reload).
 */
import { Args, Command, Flags } from "@sayknow-cli/utils/cli";
import { type DaemonCliAction, type DaemonCommandArgs, runDaemonCommand } from "../cli/daemon-cli";
import type { DaemonKind } from "../daemon/control-types";
import { DAEMON_ACTION_TOKENS, resolveDaemonAction } from "../daemon/operator-contract";
import { initTheme } from "../modes/theme/theme";

export default class Daemon extends Command {
	static description =
		"Manage SKC background daemons. Routine use: `skc daemon status` to check, `skc daemon restart` to reload (spawns one if none is running). `stop`/`list` and the escalation flags below are advanced primitives.";

	static examples = [
		"# Check the daemon (concise per-daemon result)\n  skc daemon status",
		"# Reload, spawning a fresh owner if none is running\n  skc daemon restart",
		"# Full runtime detail and the roots list\n  skc daemon status --verbose",
		"# Machine-readable output for automation\n  skc daemon status --json",
		"# Stop, hard-killing an unresponsive owner\n  skc daemon stop --force",
	];

	static args = {
		action: Args.string({
			description: "Daemon action (status, restart, reload, stop, list)",
			required: false,
			options: DAEMON_ACTION_TOKENS as string[],
		}),
		kind: Args.string({ description: "Daemon kind(s) to target", required: false, multiple: true }),
	};

	static flags = {
		verbose: Flags.boolean({ char: "v", description: "Show runtime detail and the full roots list" }),
		all: Flags.boolean({ description: "Target all registered daemon kinds" }),
		json: Flags.boolean({ description: "Emit JSON output" }),
		force: Flags.boolean({ description: "Allow hard-kill escalation when graceful stop times out" }),
		"graceful-timeout-ms": Flags.integer({ description: "Cooperative stop timeout before escalation" }),
		"kill-timeout-ms": Flags.integer({ description: "Wait for old pid death after SIGKILL" }),
		"spawn-if-stopped": Flags.boolean({ description: "On reload, spawn even when no daemon is running" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Daemon);
		const action = (resolveDaemonAction(args.action) ?? "status") as DaemonCliAction;
		const kinds = (Array.isArray(args.kind) ? args.kind : args.kind ? [args.kind] : []) as DaemonKind[];
		const flagRec = flags as Record<string, unknown>;
		const cmd: DaemonCommandArgs = {
			action,
			kinds,
			all: Boolean(flags.all),
			json: Boolean(flags.json),
			force: Boolean(flags.force),
			verbose: Boolean(flags.verbose),
			gracefulTimeoutMs: flagRec["graceful-timeout-ms"] as number | undefined,
			killTimeoutMs: flagRec["kill-timeout-ms"] as number | undefined,
			spawnIfStopped: flagRec["spawn-if-stopped"] as boolean | undefined,
		};

		await initTheme();
		await runDaemonCommand(cmd);
	}
}
