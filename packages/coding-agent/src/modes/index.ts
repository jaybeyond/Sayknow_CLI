import { emergencyTerminalRestore } from "@sayknow-cli/tui";
import { postmortem } from "@sayknow-cli/utils";

/**
 * Run modes for the coding agent.
 */
export { runAcpMode } from "./acp";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});
