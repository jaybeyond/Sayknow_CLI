// Runs a command through the bash tool's real execution paths from the
// caller-chosen cwd, so the caller can plant a project `.env` whose hook
// variables point at a marker script. The native shell runs in-process here,
// so it imports this process's environment, including the autoloaded `.env`.
//
// Modes: `worker` drives the persistent native shell session (the default bash
// tool path), `inprocess` the one-shot native shell, and `pty` the interactive
// PTY.
import * as path from "node:path";
import type { AgentToolContext } from "@sayknow-cli/agent-core";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { executeBash } from "@sayknow-cli/coding-agent/exec/bash-executor";
import { runInteractiveBashPty } from "@sayknow-cli/coding-agent/tools/bash-interactive";

const mode = process.argv[2];
const command = process.env.SKC_TEST_PROBE_COMMAND ?? "git status --short >/dev/null 2>&1; echo probe-done";
const cwd = process.cwd();
// executeBash and the PTY read the global settings instance, so `shellPath`
// is set there.
const settings = await Settings.init({ inMemory: true, cwd });
const shellPath = process.env.SKC_TEST_SHELL_PATH;
if (shellPath) settings.set("shellPath", shellPath);
const dotenvAfterStartup = process.env.SKC_TEST_DOTENV_AFTER_START;
if (dotenvAfterStartup !== undefined) await Bun.write(path.join(cwd, ".env"), dotenvAfterStartup);

function headlessUi(): NonNullable<AgentToolContext["ui"]> {
	return {
		custom<T>(factory: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				let component: { dispose?: () => void } | undefined;
				try {
					component = (
						factory as (
							tui: { terminal: { rows: number; columns: number }; requestRender: () => void },
							theme: Record<string, never>,
							keybindings: Record<string, never>,
							done: (result: T) => void,
						) => { dispose?: () => void }
					)({ terminal: { rows: 24, columns: 80 }, requestRender: () => {} }, {}, {}, result => {
						component?.dispose?.();
						resolve(result);
					});
				} catch (error) {
					reject(error);
				}
			});
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

const result =
	mode === "pty"
		? await runInteractiveBashPty(headlessUi(), { command, cwd, timeoutMs: 20_000 })
		: await executeBash(command, { cwd, timeout: 20_000, oneShot: mode === "inprocess" });
console.log(JSON.stringify({ exitCode: result.exitCode, done: result.output.includes("probe-done") }));
process.exit(0);
