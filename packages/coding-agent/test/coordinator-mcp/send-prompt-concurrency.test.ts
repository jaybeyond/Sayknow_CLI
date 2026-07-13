import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCoordinatorMcpServer } from "../../src/coordinator-mcp/server";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-coord-race-"));
	try {
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/**
 * Regression for the #1964 blocker: concurrent stdio dispatch let two same-session
 * `send_prompt` calls interleave their read-active-turn → write-new-turn, persisting two
 * "active" turns while only one active-turn pointer survived. The per-session mutation lock
 * must restore the atomicity the former serial read loop provided.
 */
describe("send_prompt same-session concurrency", () => {
	it("serializes concurrent same-session send_prompts to a single active turn", async () => {
		await withTempRoot(async root => {
			const server = await createCoordinatorMcpServer({
				env: {
					SKC_COORDINATOR_MCP_WORKDIR_ROOTS: root,
					SKC_COORDINATOR_MCP_MUTATIONS: "sessions,questions,reports",
					SKC_COORDINATOR_MCP_STATE_ROOT: path.join(root, ".state"),
					SKC_COORDINATOR_MCP_PROFILE: "race-controller",
					SKC_COORDINATOR_MCP_REPO: "repo-race",
				},
				services: {
					startSession: async (input: {
						cwd: string;
						sessionId: string;
						launchId: string;
						readinessMarkerFile: string;
					}) => {
						await Bun.write(
							input.readinessMarkerFile,
							`${JSON.stringify({
								schema_version: 1,
								session_id: input.sessionId,
								launch_id: input.launchId,
								state: "ready_for_input",
								event: "interactive_input_ready",
								source: "skc_interactive_runtime",
								ready_for_input: true,
								created_at: "2026-07-11T00:00:00.000Z",
							})}\n`,
						);
						return {
							name: input.sessionId,
							sessionId: input.sessionId,
							launchId: input.launchId,
							readinessMarkerFile: input.readinessMarkerFile,
							cwd: input.cwd,
							createdAt: "2026-07-11T00:00:00.000Z",
						};
					},
				},
			});

			const started = await server.callTool("skc_coordinator_start_session", {
				cwd: root,
				allow_mutation: true,
			});
			expect(started.ok).toBe(true);
			const sessionId = (started.session as { session_id: string }).session_id;

			// The exact race the maintainer reproduced 25/25: two same-session prompts at once.
			const results = await Promise.all([
				server.callTool("skc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "first concurrent prompt",
					allow_mutation: true,
				}),
				server.callTool("skc_coordinator_send_prompt", {
					session_id: sessionId,
					prompt: "second concurrent prompt",
					allow_mutation: true,
				}),
			]);

			const actives = results.filter(r => r.ok === true && r.status === "active");
			const conflicts = results.filter(r => r.ok === false && r.reason === "active_turn_exists");

			// Serialized: exactly one wins the active turn; the other observes it and is rejected.
			// Without the lock both persisted `status: "active"` (actives.length === 2).
			expect(actives.length).toBe(1);
			expect(conflicts.length).toBe(1);
			expect(conflicts[0]?.active_turn_id).toBe(actives[0]?.turn_id);
		});
	});
});
