// Prints the tmux command the public reader resolves.
// Spawned with a controlled cwd so Bun loads that directory's `.env` before
// the reader consults `projectEnvSnapshot`.
import * as fs from "node:fs";
import * as os from "node:os";
import { resolveSkcTmuxCommand } from "../../src/skc-runtime/tmux-common";

const drop = process.env.SKC_TMUX_COMMAND_PROBE_DROP;
if (drop === "unlink") fs.rmSync(".env", { force: true });
else if (drop === "chdir") process.chdir(os.tmpdir());

console.log(
	JSON.stringify({
		command: resolveSkcTmuxCommand(),
		envCommand: process.env.SKC_TMUX_COMMAND ?? null,
	}),
);
