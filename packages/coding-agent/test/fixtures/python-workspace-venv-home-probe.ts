import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { pythonBackend } from "@sayknow-cli/coding-agent/eval";
import { checkPythonKernelAvailability } from "@sayknow-cli/coding-agent/eval/py/kernel";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import { resetShellConfigCache } from "@sayknow-cli/utils/shell-config";

const cwd = process.argv[2];
if (!cwd) {
	console.error("cwd required");
	process.exit(2);
}
for (const key of [
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"NODE_ENV",
	"BUN_ENV",
	"SKC_PYTHON_SKIP_CHECK",
	"PI_PYTHON_SKIP_CHECK",
]) {
	delete Bun.env[key];
}
resetShellConfigCache();
const settings = Settings.isolated();
const session = { cwd, hasUI: false, settings } as ToolSession;
await pythonBackend.isAvailable(session);
const availability = await checkPythonKernelAvailability(cwd);
console.log(JSON.stringify({ ok: availability.ok, pythonPath: availability.pythonPath ?? null }));
