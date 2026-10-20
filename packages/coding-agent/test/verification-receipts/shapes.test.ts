/**
 * AC15 drift canaries: the hooks key on emitted tool shapes. If the producers change, these fail first.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { transcriptFacts } from "../../bundles/verification-receipts/hooks/verification-baseline";
import {
	d16,
	jobItems,
	normalizeStatus,
	parseLaunchText,
	subagentItems,
	TERMINAL_STATUSES,
} from "../../bundles/verification-receipts/hooks/verification-gate";
import { AsyncJobManager } from "../../src/async/job-manager";
import { createReadonlySessionManager, SessionManager } from "../../src/session/session-manager";
import { taskSchema } from "../../src/task/types";
import { JobTool, type JobToolDetails } from "../../src/tools/job";
import type { SubagentSnapshot } from "../../src/tools/subagent";

const SRC = path.resolve(import.meta.dir, "../../src");

describe("task launch listing", () => {
	it("the producer template still has the shape the parser reads", async () => {
		const text = await Bun.file(path.join(SRC, "task/index.ts")).text();
		const D = "$" + "{";
		expect(text).toContain(
			`\`Started ${D}startedJobs.length} background task job${D}startedJobs.length === 1 ? "" : "s"} using ${D}params.agent}.`,
		);
		expect(text).toContain(`const prefix = \`- \\\`${D}id}\\\` (job \\\`${D}jobId}\\\`)\`;`);
		expect(text).toContain('async: { state: "running", jobId: startedJobs[0].jobId, type: "task" }');
	});

	it("yields every jobId from a producer-shaped multi-item listing (with descriptions)", () => {
		const listing = ["task-a", "task-b", "task-c"]
			.map((id, i) => `- \`${id}\` (job \`job-${i}\`) — do the thing ${i}`)
			.join("\n");
		const text = `Started 3 background task jobs using executor. Results will be delivered when complete.\n${listing}\n Use \`subagent\` to list, inspect, or await.`;
		const parsed = parseLaunchText(text, "job-0");
		expect(parsed.complete).toBe(true);
		expect(parsed.jobs.map(j => j.jobId)).toEqual(["job-0", "job-1", "job-2"]);
		expect(parsed.jobs.map(j => j.subagentId)).toEqual(["task-a", "task-b", "task-c"]);
	});

	it("handles the singular form and scheduling-failure summaries", () => {
		const text =
			"Started 1 background task job using executor. Failed to schedule 1 task. Results will be delivered when complete.\n- `t` (job `only`)\n use";
		expect(parseLaunchText(text, "only")).toMatchObject({ complete: true, expected: 1 });
	});

	it("falls back to a partial set for cold-spilled, pruned or unparseable text", () => {
		for (const text of [undefined, "", "[content evicted]", "Started many background task jobs"]) {
			const parsed = parseLaunchText(text, "j9");
			expect(parsed).toMatchObject({ complete: false, jobs: [{ jobId: "j9", subagentId: "j9" }] });
		}
	});

	it("a listing that does not contain the async job id stays partial and includes it", () => {
		const parsed = parseLaunchText("Started 1 background task job using x.\n- `a` (job `other`)", "async-job");
		expect(parsed.complete).toBe(false);
		expect(parsed.jobs.map(j => j.jobId)).toContain("async-job");
	});

	it("never trusts a count above 64 or a count mismatch", () => {
		expect(parseLaunchText("Started 65 background task jobs using x.\n- `a` (job `b`)", "b").complete).toBe(false);
		expect(parseLaunchText("Started 3 background task jobs using x.\n- `a` (job `b`)", "b").complete).toBe(false);
	});
});

describe("subagent and job result shapes (real producers and exhaustive type canaries)", () => {
	// Exhaustive over the producer's status union: a new/removed status breaks tsgo here first.
	const SUBAGENT_STATUSES: Record<SubagentSnapshot["status"], true> = {
		running: true,
		paused: true,
		queued: true,
		completed: true,
		failed: true,
		cancelled: true,
		not_found: true,
		already_completed: true,
	};

	it("every SubagentSnapshot status (incl. queued) survives the closed set and keys the extractor", () => {
		for (const status of Object.keys(SUBAGENT_STATUSES) as SubagentSnapshot["status"][]) {
			const snapshot = {
				id: "agent-1",
				jobId: "job-1",
				status,
				label: "l",
				agent: "executor",
				agentSource: "bundled",
				durationMs: 1,
			} satisfies SubagentSnapshot;
			expect(normalizeStatus(snapshot.status)).toBe(status);
			expect(subagentItems({ subagents: [snapshot] })).toEqual([[d16("job-1"), d16("agent-1"), status]]);
		}
		expect(TERMINAL_STATUSES.has("queued")).toBe(false);
	});

	it("the real JobTool emits the shapes the gate keys on: type task, running/terminal status, cancelled[]", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		AsyncJobManager.setInstance(manager);
		try {
			let release: (value: string) => void = () => {};
			const taskId = manager.register("task", "agent task", () => new Promise<string>(r => (release = r)));
			const bashId = manager.register("bash", "sleep", () => new Promise<string>(() => {}));
			const tool = new JobTool({} as never);
			const listed = (await tool.execute("c1", { list: true })).details as JobToolDetails;
			const running = jobItems(listed);
			expect(running.items).toEqual(
				expect.arrayContaining([
					[d16(taskId), "task", "running"],
					[d16(bashId), "other", "running"],
				]),
			);
			expect(running.activeTaskJob).toBe(true);
			release("done");
			for (let i = 0; i < 100 && manager.getJob(taskId)?.status === "running"; i++) await Bun.sleep(10);
			const done = (await tool.execute("c2", { list: true })).details as JobToolDetails;
			expect(jobItems(done).items).toContainEqual([d16(taskId), "task", "completed"]);
			expect(jobItems(done).activeTaskJob).toBe(false); // the running bash job never blocks quiescence
			const cancelled = (await tool.execute("c3", { cancel: [bashId] })).details as JobToolDetails;
			expect(cancelled.cancelled?.[0]).toMatchObject({ id: bashId, status: "cancelled" });
			expect(jobItems(cancelled).items).toContainEqual([d16(bashId), "task", "cancelled"]);
		} finally {
			AsyncJobManager.setInstance(undefined);
			await manager.dispose({ timeoutMs: 500 });
		}
	});

	it("the `list` job parameter and the task `isolated` parameter still exist on their producers", () => {
		expect("list" in new JobTool({} as never).parameters.shape).toBe(true);
		expect("isolated" in taskSchema.shape).toBe(true);
	});

	it("the async-result custom_message written by SessionManager keeps the shape the walk reads", async () => {
		const sm = SessionManager.inMemory("/tmp/skc-vr-shapes-unused");
		const id = sm.appendCustomMessageEntry("async-result", "done", true, {
			jobs: [{ jobId: "job-A", type: "task", label: "x", durationMs: 5 }],
		});
		const entry = createReadonlySessionManager(sm).getEntry(id) as unknown as Record<string, unknown>;
		expect(entry).toMatchObject({ type: "custom_message", customType: "async-result" });
		const facts = transcriptFacts([entry]);
		expect(facts.obs).toHaveLength(1);
		expect(facts.obs[0]).toMatchObject({
			source: "async_result",
			items: [{ jobD: d16("job-A"), status: "completed_or_failed" }],
		});
		// the producer still builds exactly this entry (customType and details.jobs[].jobId)
		const producer = await Bun.file(path.join(SRC, "sdk/session.ts")).text();
		expect(producer).toContain('customType: "async-result"');
		expect(producer).toMatch(/jobs: jobs\.map\(job => \(\{\s+jobId: job\.jobId,/);
	});

	it("subagent/job results in a SessionManager transcript produce the same items as the hook extractor", () => {
		const sm = SessionManager.inMemory("/tmp/skc-vr-shapes-unused");
		const jobDetails = {
			jobs: [
				{ id: "bash-1", type: "bash", status: "running" },
				{ id: "task-1", type: "task", status: "running" },
			],
			cancelled: [{ id: "task-2", status: "cancelled" }],
		};
		const subDetails = { subagents: [{ id: "a-1", jobId: "j-1", status: "inferred" }] };
		for (const [toolName, toolCallId, details] of [
			["job", "tc-job", jobDetails],
			["subagent", "tc-sub", subDetails],
		] as const) {
			sm.appendMessage({
				role: "toolResult",
				toolName,
				toolCallId,
				content: [{ type: "text", text: "ok" }],
				details,
				isError: false,
				timestamp: Date.now(),
			} as never);
		}
		const facade = createReadonlySessionManager(sm);
		const entries: Record<string, unknown>[] = [];
		for (let id = facade.getLeafId(); id; ) {
			const e = facade.getEntry(id) as unknown as Record<string, unknown>;
			entries.unshift(e);
			id = (e.parentId as string | null) ?? null;
		}
		const { obs } = transcriptFacts(entries);
		const jobObs = obs.find(o => o.source === "job");
		expect(jobObs?.items.map(i => [i.jobD, i.type, i.status])).toEqual(jobItems(jobDetails).items);
		// a running non-task job in a cancel result must stay "other" (no spurious discovered gate)
		expect(jobObs?.items[0]).toMatchObject({ type: "other", status: "running" });
		const subObs = obs.find(o => o.source === "subagent");
		expect(subObs?.items.map(i => [i.jobD, i.subD, i.status])).toEqual(subagentItems(subDetails));
		expect(subObs?.items[0]?.status).toBe("unknown"); // raw `inferred` is outside the closed set
	});
	it("terminal statuses are exactly the closed set; everything else (incl. paused/unknown) is non-terminal", () => {
		expect([...TERMINAL_STATUSES].sort()).toEqual(["already_completed", "cancelled", "completed", "failed"]);
		expect(normalizeStatus("running")).toBe("running");
		expect(normalizeStatus("paused")).toBe("paused");
		expect(normalizeStatus("brand-new-status")).toBe("unknown");
		expect(normalizeStatus(undefined)).toBe("unknown");
	});
	it("ids are stored as the first 16 hex of sha256 only", () => {
		expect(d16("job-1")).toMatch(/^[0-9a-f]{16}$/);
		expect(d16("job-1")).not.toContain("job");
	});
});
