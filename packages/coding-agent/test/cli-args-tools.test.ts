import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("--tools parsing", () => {
	test("keeps non-builtin names so plugin, custom, and MCP tools resolve at session start", () => {
		// Regression: dropping unknown names left `toolNames = []`, which the session
		// treats as an explicit zero-tool selection and disables every tool.
		expect(parseArgs(["--tools", "verification_run,verification_status"]).tools).toEqual([
			"verification_run",
			"verification_status",
		]);
	});

	test("lowercases, trims, drops empties, and dedupes", () => {
		expect(parseArgs(["--tools", " Read ,,bash,READ, mcp_server_tool "]).tools).toEqual([
			"read",
			"bash",
			"mcp_server_tool",
		]);
	});
});
