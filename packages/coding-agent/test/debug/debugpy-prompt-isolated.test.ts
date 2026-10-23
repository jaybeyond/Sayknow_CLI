import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { DebugTool } from "../../src/tools/debug";

const ISOLATED_ADAPTER = "`python -I -m debugpy.adapter`";

function session(): ToolSession {
	return {
		cwd: ".",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	} as ToolSession;
}

// The fork has no generated tool catalog; the prompt text is checked on the tool
// itself and against the adapter command it actually launches.
describe("debugpy adapter prompt", () => {
	it("shows the isolated debugpy adapter command on the debug tool", () => {
		const tool = new DebugTool(session());
		expect(tool.description).toContain(ISOLATED_ADAPTER);
	});

	it("matches the adapter command the debugpy default launches", () => {
		const defaults = JSON.parse(
			fs.readFileSync(path.join(import.meta.dir, "../../src/dap/defaults.json"), "utf8"),
		) as Record<string, { args?: string[] }>;
		expect(defaults.debugpy?.args).toEqual(["-I", "-m", "debugpy.adapter"]);
	});

	it("still allows gdb, lldb-dap, and dlv dap in the debug tool prompt", () => {
		const tool = new DebugTool(session());
		for (const name of ["`gdb`", "`lldb-dap`", "`dlv dap`"]) {
			expect(tool.description).toContain(name);
		}
	});
});
