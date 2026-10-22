// The guard import is evaluated before the drop below, so it snapshots this
// process cwd before `.env` is removed or the process chdirs.

import * as fs from "node:fs";
import * as os from "node:os";
import type { AgentTool } from "@sayknow-cli/agent-core";
import { getWorkflowMutationDecision } from "@sayknow-cli/coding-agent/skill-state/workflow-mutation-guard";

const drop = process.env.SKC_TMPDIR_PROBE_DROP ?? "";
if (drop === "unlink") fs.unlinkSync("./.env");
else if (drop === "chdir") process.chdir(os.tmpdir());
else if (drop !== "") throw new Error(`unexpected SKC_TMPDIR_PROBE_DROP ${drop}`);

const expectedTmpdir = process.env.SKC_TMPDIR_PROBE_EXPECT;
if (expectedTmpdir !== undefined && process.env.TMPDIR !== expectedTmpdir) {
	throw new Error(`Bun did not load TMPDIR from .env (saw ${process.env.TMPDIR ?? "<unset>"})`);
}

const cwd = process.env.SKC_TMPDIR_PROBE_CWD;
const target = process.env.SKC_TMPDIR_PROBE_PATH;
const sessionId = process.env.SKC_TMPDIR_PROBE_SESSION;
if (!cwd || !target || !sessionId) throw new Error("tmpdir probe is missing cwd, path, or session");

const decision = await getWorkflowMutationDecision({
	cwd,
	sessionId,
	tool: {
		name: "write",
		label: "write",
		description: "write",
		parameters: {},
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	} as AgentTool,
	args: { path: target, content: "mutated" },
});
process.stdout.write(`${JSON.stringify({ blocked: decision.blocked, message: decision.message })}\n`);
