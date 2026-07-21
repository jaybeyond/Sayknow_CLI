import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@sayknow-cli/agent-core";
import { getWorkflowMutationDecision } from "../../src/skill-state/workflow-mutation-guard";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-acl-gate-"));
	const priorSessionId = process.env.SKC_SESSION_ID;
	process.env.SKC_SESSION_ID = "test-session";
	try {
		await fn(dir);
	} finally {
		if (priorSessionId !== undefined) process.env.SKC_SESSION_ID = priorSessionId;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function tool(name: string, extra: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: {} as never,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		...extra,
	} as AgentTool;
}

describe("G2 skc ACL gate", () => {
	it("blocks mutation tools targeting .skc paths", async () => {
		await withTempCwd(async cwd => {
			const blockedCases: Array<[AgentTool, unknown]> = [
				[tool("write"), { path: ".skc/state/foo.json", content: "{}" }],
				[tool("edit"), { path: ".skc/specs/spec.md", edits: [{ old_text: "a", new_text: "b" }] }],
				[tool("ast_edit"), { paths: [".skc/state/foo.json"], ops: [{ pat: "foo", out: "bar" }] }],
			];

			for (const [targetTool, args] of blockedCases) {
				const decision = await getWorkflowMutationDecision({ cwd, tool: targetTool, args });
				expect(decision.blocked).toBe(true);
				expect(decision.message).toContain("runtime-owned");
				if (decision.reason !== "unknown-target") {
					expect(["skc-target", "workflow-state-target"]).toContain(decision.reason as string);
				}
			}
		});
	});

	it("allows sanctioned skc bash commands, bash mutations, and non-.skc writes", async () => {
		await withTempCwd(async cwd => {
			const skcCommand = await getWorkflowMutationDecision({
				cwd,
				tool: tool("bash"),
				args: { command: "skc state ralplan write --input '{}'" },
			});
			expect(skcCommand.blocked).toBe(false);

			const bashMutation = await getWorkflowMutationDecision({
				cwd,
				tool: tool("bash"),
				args: { command: "rm -rf .skc/specs" },
			});
			expect(bashMutation.blocked).toBe(false);

			const productWrite = await getWorkflowMutationDecision({
				cwd,
				tool: tool("write"),
				args: { path: "src/product.ts", content: "x" },
			});
			expect(productWrite.blocked).toBe(false);

			// Per #951 the mutation guard never blocks `bash`; `.skc/**` is gated only
			// through the dedicated write/edit/ast_edit tools, so bash targeting .skc is allowed.
			for (const command of ["echo x > .skc/state/foo.json", "rm -rf .skc/specs"]) {
				const skcBash = await getWorkflowMutationDecision({ cwd, tool: tool("bash"), args: { command } });
				expect(skcBash.blocked).toBe(false);
			}
		});
	});
});
