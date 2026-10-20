import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateToolArguments } from "@sayknow-cli/ai/utils/validation";
import { createReadonlySessionManager, SessionManager } from "../../src/session/session-manager";
import {
	cleanupTemps,
	type Env,
	git,
	type Installed,
	loadInstalled,
	mkEnv,
	mkPi,
	mkRepo,
	mkTemp,
	PASS_TEST,
	write,
} from "./helpers";

afterEach(cleanupTemps);

class FakeSession {
	entries = new Map<string, Record<string, unknown>>();
	leaf: string | null = null;
	getEntryCalls = 0;
	#n = 0;
	constructor(readonly id: string) {}
	getSessionId = () => this.id;
	getLeafId = () => this.leaf;
	getEntry = (id: string) => {
		this.getEntryCalls++;
		return this.entries.get(id);
	};
	getBranch = () => {
		throw new Error("getBranch must never be called");
	};
	getHeader = () => ({ type: "session", id: this.id });
	add(entry: Record<string, unknown>, parent: string | null = this.leaf): string {
		const id = `e${++this.#n}`.padStart(8, "0");
		this.entries.set(id, { id, parentId: parent, timestamp: new Date().toISOString(), ...entry });
		this.leaf = id;
		return id;
	}
	call(toolCallId: string) {
		return this.add({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: {} }] },
		});
	}
	launch(toolCallId: string, jobIds: string[], text?: string) {
		this.call(toolCallId);
		const body =
			text ??
			`Started ${jobIds.length} background task jobs using agent.\n${jobIds.map((j, i) => `- \`sub${i}\` (job \`${j}\`)`).join("\n")}\n`;
		return this.add({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "task",
				toolCallId,
				isError: false,
				content: [{ type: "text", text: body }],
				details: { async: { state: "running", jobId: jobIds[0] } },
			},
		});
	}
	asyncResult(jobIds: string[]) {
		return this.add({
			type: "custom_message",
			customType: "async-result",
			details: { jobs: jobIds.map(jobId => ({ jobId })) },
			content: "done",
			display: true,
		});
	}
	result(toolName: string, toolCallId: string, details: unknown) {
		return this.add({
			type: "message",
			message: {
				role: "toolResult",
				toolName,
				toolCallId,
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details,
			},
		});
	}
}

interface World {
	env: Env;
	repo: string;
	m: Installed;
	session: FakeSession;
	loop: (deps?: Parameters<Installed["loop"]["executeLoop"]>[2]) => ReturnType<Installed["loop"]["executeLoop"]>;
	run: (files?: string[]) => ReturnType<Installed["run"]["executeRun"]>;
	hooks: ReturnType<Installed["gate"]["createGateHandler"]>;
	baselineHook: ReturnType<Installed["baseline"]["createBaselineHandler"]>;
	hookCtx: { cwd: string; sessionManager: { getSessionId(): string } };
}

async function world(sessionId = `S${Math.random().toString(36).slice(2)}`): Promise<World> {
	const env = await mkEnv();
	const repo = await mkRepo();
	const m = await loadInstalled(env);
	const session = new FakeSession(sessionId);
	const pi = mkPi(repo, env);
	const hookDeps = { fs, now: () => Date.now(), sleep: m.gate.defaultSleep, budgetMs: 1500, storeRoot: env.storeRoot };
	return {
		env,
		repo,
		m,
		session,
		loop: deps => m.loop.executeLoop(pi, { sessionManager: session }, { env: env.env, ...deps }, env.toolsDir),
		run: (files = ["a.test.ts"]) =>
			m.run.executeRun(
				pi,
				{ sessionManager: session },
				`run-${Math.random()}`,
				{ files },
				undefined,
				{ env: env.env },
				env.toolsDir,
			),
		hooks: m.gate.createGateHandler(hookDeps),
		baselineHook: m.baseline.createBaselineHandler(hookDeps),
		hookCtx: { cwd: repo, sessionManager: session },
	};
}
const tick = () => Bun.sleep(4);
const launchResult = (toolCallId: string, jobIds: string[]) => ({
	toolName: "task",
	toolCallId,
	isError: false,
	input: {},
	content: [
		{
			type: "text",
			text: `Started ${jobIds.length} background task jobs using agent.\n${jobIds.map((j, i) => `- \`sub${i}\` (job \`${j}\`)`).join("\n")}\n`,
		},
	],
	details: { async: { state: "running", jobId: jobIds[0] } },
});
const jobDone = (ids: string[], list = true) => ({
	toolName: "job",
	toolCallId: `j-${Math.random()}`,
	isError: false,
	input: { list },
	content: [],
	details: { jobs: ids.map(id => ({ id, type: "task", status: "completed" })) },
});

describe("verification_loop: transcript reconstruction (no hook events)", () => {
	it("empty session is clean with no_gates_recorded and a private ledger", async () => {
		const w = await world();
		const d = await w.loop();
		expect(d).toMatchObject({ status: "clean", scope: "current_session", openGates: 0, advisoryOnly: true });
		expect(d.notes).toContain("no_gates_recorded");
		const ledgerRoot = path.join(w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(ledgerRoot);
		const files = await fs.readdir(path.join(ledgerRoot, repoDir as string));
		expect(files).toHaveLength(1);
		expect((await fs.stat(path.join(ledgerRoot, repoDir as string, files[0] as string))).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(path.join(w.env.storeRoot, "journal", "v1"))).length).toBe(1);
	});

	it("launch -> unobserved; async-result -> no receipt; run -> clean; stale after an edit is not re-opened", async () => {
		const w = await world();
		w.session.launch("tc1", ["job-1"]);
		const g1 = await w.loop();
		expect(g1).toMatchObject({ status: "gaps", openGates: 1, transcript: { reconstructedGates: 1 } });
		expect(g1.gapKinds).toEqual(["delegation_terminal_unobserved"]);
		expect(g1.gates[0]).toMatchObject({ origin: "transcript", trigger: "task_launch", jobSetComplete: true });
		await tick();
		w.session.asyncResult(["job-1"]);
		await tick();
		const g2 = await w.loop();
		expect(g2.gapKinds).toEqual(["no_receipt_after_terminal"]);
		expect(g2.requiredActions[0]).toContain("verification_run");
		const run = await w.run();
		expect(run.execution.status).toBe("passed");
		const g3 = await w.loop();
		expect(g3).toMatchObject({ status: "clean", openGates: 0, resolvedGates: 1, newlyResolved: 1 });
		expect(g3.gates[0]?.resolution).toBe("receipts");
		await write(w.repo, "a.ts", "export const a = 5;\n");
		const g4 = await w.loop();
		expect(g4).toMatchObject({ status: "clean", openGates: 0, newlyResolved: 0 });
	});

	it("an edit after the receipt makes it receipt_stale; a failing receipt is receipt_not_passed; uncovered changed tests are listed", async () => {
		const w = await world();
		w.session.launch("tc1", ["job-1"]);
		await tick();
		w.session.asyncResult(["job-1"]);
		await tick();
		await w.run();
		await write(w.repo, "a.ts", "export const a = 9;\n");
		expect((await w.loop()).gapKinds).toEqual(["receipt_stale"]);
		await write(w.repo, "a.ts", "export const a = 1;\n");
		await write(w.repo, "new.test.ts", PASS_TEST);
		await w.run(["a.test.ts"]);
		const uncovered = await w.loop();
		expect(uncovered.gapKinds).toEqual(["changed_test_uncovered"]);
		expect(uncovered.uncoveredTests).toEqual(["new.test.ts"]);
		await write(
			w.repo,
			"bad.test.ts",
			`import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(2));\n`,
		);
		await w.run(["bad.test.ts"]);
		expect((await w.loop()).gapKinds).toEqual(["receipt_not_passed"]);
		await fs.rm(path.join(w.repo, "bad.test.ts"));
		await w.run(["a.test.ts", "new.test.ts"]);
		const final = await w.loop();
		expect(final.gapKinds).toEqual([]);
		expect(final.status).toBe("clean");
	});

	it("a cold-spilled launch is a partial set: it needs observed quiescence even after the async-result", async () => {
		const w = await world();
		w.session.launch("tc1", ["job-1"], "[cold spill]");
		await tick();
		w.session.asyncResult(["job-1"]);
		await tick();
		const d = await w.loop();
		expect(d.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		expect(d.gates[0]?.jobSetComplete).toBe(false);
		// quiescence arrives as a hook event (job list with no running task job)
		await w.hooks(jobDone(["job-1"]), w.hookCtx);
		await tick();
		await w.run();
		const clean = await w.loop();
		expect(clean.status).toBe("clean");
	});

	it("never calls getBranch and bounds getEntry by WALK_CAP", async () => {
		const w = await world();
		for (let i = 0; i < 30; i++) w.session.add({ type: "message", message: { role: "user", content: "x" } });
		w.session.getEntryCalls = 0;
		const d = await w.loop({ walkCap: 12 });
		expect(w.session.getEntryCalls).toBeLessThanOrEqual(12 + 2);
		expect(d.transcript).toMatchObject({ truncated: true, pendingSegment: true });
		expect(d.gapKinds).toContain("scan_truncated");
	});

	it("WALK_CAP=10 with 15 new entries needs two runs; the cursor only reaches the leaf after the second", async () => {
		const w = await world();
		w.session.launch("tc1", ["job-1"]);
		for (let i = 0; i < 12; i++) w.session.add({ type: "message", message: { role: "user", content: "x" } });
		const r1 = await w.loop({ walkCap: 10 });
		expect(r1).toMatchObject({ status: "gaps", openGates: 0, transcript: { truncated: true, pendingSegment: true } });
		expect(r1.gapKinds).toEqual(["scan_truncated"]);
		const r2 = await w.loop({ walkCap: 10 });
		expect(r2.transcript).toMatchObject({ truncated: false, pendingSegment: false, reconstructedGates: 1 });
		expect(r2.gapKinds).toEqual(["delegation_terminal_unobserved"]);
		const r3 = await w.loop({ walkCap: 10 });
		expect(r3.transcript.walkedEntries).toBe(0);
	});

	it("a branch switch rescans back to the floor", async () => {
		const w = await world();
		const root = w.session.add({ type: "message", message: { role: "user", content: "root" } });
		w.session.launch("tcA", ["jobA"]);
		const branchA = w.session.leaf;
		await w.loop();
		w.session.leaf = root;
		w.session.launch("tcB", ["jobB"]);
		const d = await w.loop();
		expect(d.transcript.reconstructedGates).toBe(1);
		expect(d.openGates).toBe(2);
		expect(branchA).not.toBe(w.session.leaf);
	});

	it("ignores history older than the activation floor and error results", async () => {
		const w = await world();
		const old = w.session.launch("tcOld", ["jobOld"]);
		(w.session.entries.get(old) as Record<string, unknown>).timestamp = new Date(
			Date.now() - 3_600_000,
		).toISOString();
		w.session.add({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "task",
				toolCallId: "tcE",
				isError: true,
				content: [],
				details: { async: { state: "running", jobId: "jE" } },
			},
		});
		const d = await w.loop();
		expect(d.openGates).toBe(0);
	});

	it("a subagent resume (running job in no gate) opens a gate; a queued resume waits for its own job", async () => {
		const w = await world();
		w.session.result("subagent", "s1", { subagents: [{ id: "agent-1", jobId: "job-r", status: "running" }] });
		await tick();
		w.session.result("subagent", "s2", { subagents: [{ id: "agent-2", jobId: "job-q", status: "queued" }] });
		const d = await w.loop();
		expect(d.openGates).toBe(2);
		expect(d.gates.map(g => g.trigger).sort()).toEqual(["subagent_resume", "subagent_resume"]);
		await tick();
		w.session.result("subagent", "s3", { subagents: [{ id: "agent-1", jobId: "job-r", status: "completed" }] });
		w.session.result("subagent", "s4", { subagents: [{ id: "agent-2", jobId: "job-n", status: "completed" }] });
		const d2 = await w.loop();
		// the running resume is complete once its job is terminal; the queued one still needs quiescence
		const running = d2.gates.find(g => g.jobSetComplete);
		const queued = d2.gates.find(g => !g.jobSetComplete);
		expect(running?.gapKinds).toEqual(["no_receipt_after_terminal"]);
		expect(queued?.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		expect(queued?.jobs).toEqual({ total: 1, terminal: 1 });
		await tick();
		await w.hooks(jobDone(["job-r", "job-n"]), w.hookCtx);
		expect((await w.loop()).gates.find(g => !g.jobSetComplete)?.gapKinds).toEqual(["no_receipt_after_terminal"]);
	});
});

describe("verification_loop: hook events", () => {
	it("baseline + launch + terminal events + dirty-tree no_change (E2E-4)", async () => {
		const w = await world();
		await write(w.repo, "dirty.ts", "dirty");
		await w.run();
		await tick();
		await w.baselineHook({ toolName: "task", toolCallId: "tc1" }, w.hookCtx);
		await w.hooks(launchResult("tc1", ["job-1"]), w.hookCtx);
		await tick();
		await w.hooks(jobDone(["job-1"]), w.hookCtx);
		const d = await w.loop();
		expect(d).toMatchObject({ status: "clean", openGates: 0, resolvedGates: 1 });
		expect(d.gates[0]).toMatchObject({ origin: "hook", baselineSource: "before_hook", resolution: "no_change" });
		// the same events are consumed: a second run does not change anything
		expect((await w.loop()).status).toBe("clean");
		const ev = path.join(w.env.storeRoot, "events", "v1");
		const [repoDir] = await fs.readdir(ev);
		const [sessDir] = await fs.readdir(path.join(ev, repoDir as string));
		expect(await fs.readdir(path.join(ev, repoDir as string, sessDir as string))).toEqual([]);
	});

	it("a change after the baseline defeats no_change (E2E-2): no receipt -> receipt -> edit -> receipt_stale -> rerun -> clean", async () => {
		const w = await world();
		await w.run();
		await tick();
		await w.baselineHook({ toolName: "task", toolCallId: "tc1" }, w.hookCtx);
		await w.hooks(launchResult("tc1", ["job-1"]), w.hookCtx);
		await tick();
		await write(w.repo, "a.ts", "export const a = 3;\n");
		await w.hooks(jobDone(["job-1"]), w.hookCtx);
		await tick();
		expect((await w.loop()).gapKinds).toEqual(["no_receipt_after_terminal"]);
		await w.run();
		await write(w.repo, "a.ts", "export const a = 4;\n");
		expect((await w.loop()).gapKinds).toEqual(["receipt_stale"]);
		await w.run();
		expect((await w.loop()).status).toBe("clean");
	});

	it("the before_hook baseline is used for the changed-set (a delegate-committed test must be covered)", async () => {
		const w = await world();
		await w.baselineHook({ toolName: "task", toolCallId: "tc1" }, w.hookCtx);
		await w.hooks(launchResult("tc1", ["job-1"]), w.hookCtx);
		await write(w.repo, "deleg.test.ts", PASS_TEST);
		await git(w.repo, "add", "-A");
		await git(w.repo, "commit", "-q", "-m", "delegate");
		await tick();
		await w.hooks(jobDone(["job-1"]), w.hookCtx);
		await tick();
		await w.run();
		const d = await w.loop();
		expect(d.gapKinds).toEqual(["changed_test_uncovered"]);
		expect(d.uncoveredTests).toEqual(["deleg.test.ts"]);
		await w.run(["a.test.ts", "deleg.test.ts"]);
		expect((await w.loop()).status).toBe("clean");
	});

	it("a DROP marker is reconciled by a complete walk and kept (gate_state_dropped) under a truncated one", async () => {
		const w = await world();
		const failingFs = {
			...fs,
			open: async (file: string, ...rest: unknown[]) => {
				if (String(file).includes("-launch-")) throw Object.assign(new Error("EIO"), { code: "EIO" });
				return (fs.open as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
			},
		} as unknown as typeof fs;
		const flaky = w.m.gate.createGateHandler({
			fs: failingFs,
			now: () => Date.now(),
			sleep: w.m.gate.defaultSleep,
			budgetMs: 1500,
			storeRoot: w.env.storeRoot,
		});
		const res = await flaky(launchResult("tc1", ["job-1"]), w.hookCtx);
		expect((res?.content as Array<{ text: string }>)[1]?.text).toContain("ledger=unrecorded");
		w.session.launch("tc1", ["job-1"]);
		for (let i = 0; i < 12; i++) w.session.add({ type: "message", message: { role: "user", content: "x" } });
		const truncated = await w.loop({ walkCap: 8 });
		expect(truncated.gapKinds).toEqual(expect.arrayContaining(["gate_state_dropped", "scan_truncated"]));
		const dir = async () => {
			const ev = path.join(w.env.storeRoot, "events", "v1");
			const [r] = await fs.readdir(ev);
			const [s] = await fs.readdir(path.join(ev, r as string));
			return fs.readdir(path.join(ev, r as string, s as string));
		};
		expect((await dir()).some(f => f.startsWith("DROP-"))).toBe(true);
		await w.loop({ walkCap: 8 });
		const full = await w.loop();
		expect(full.gates.map(g => g.origin)).toContain("transcript");
		expect(full.gapKinds).not.toContain("gate_state_dropped");
		expect(full.gapKinds).not.toContain("scan_truncated");
		expect((await dir()).filter(f => f.startsWith("DROP-"))).toEqual([]);
	});
});

describe("verification_loop: quiescence ordering and event merge", () => {
	const partialLaunch = (toolCallId: string, jobId: string) => ({
		...launchResult(toolCallId, [jobId]),
		content: [{ type: "text", text: "[cold spill]" }],
	});
	const eventsDir = async (w: World): Promise<string> => {
		const ev = path.join(w.env.storeRoot, "events", "v1");
		const [r] = await fs.readdir(ev);
		const [s] = await fs.readdir(path.join(ev, r as string));
		return path.join(ev, r as string, s as string);
	};
	const ledgerOf = async (w: World) => {
		const root = path.join(w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(root);
		const file = (await fs.readdir(path.join(root, repoDir as string))).find(f => f.endsWith(".json")) as string;
		return {
			file: path.join(root, repoDir as string, file),
			body: JSON.parse(await fs.readFile(path.join(root, repoDir as string, file), "utf8")),
		};
	};

	it("launch(partial) -> job list -> the FIRST loop already clears job_set_partial (same-batch quiescence)", async () => {
		const w = await world();
		await w.hooks(partialLaunch("tc1", "job-1"), w.hookCtx);
		await tick();
		await w.hooks(jobDone(["job-1"]), w.hookCtx); // observation + quiescence events
		const kinds = (await fs.readdir(await eventsDir(w))).map(f => f.split("-")[1]);
		expect(kinds.sort()).toEqual(["job", "launch", "quiescence"]);
		const d = await w.loop();
		expect(d.gapKinds).toEqual(["no_receipt_after_terminal"]);
		expect(d.gapKinds).not.toContain("delegation_job_set_partial");
		expect((await ledgerOf(w)).body.gates[0].quiescentAt).not.toBeNull();
		expect(await fs.readdir(await eventsDir(w))).toEqual([]);
	});

	it("quiescence for a launch admitted only at step 9 is applied, and kept while the launch is still retained", async () => {
		const w = await world();
		for (let i = 0; i < 64; i++) await w.hooks(launchResult(`tc${i}`, [`job-${i}`]), w.hookCtx);
		await w.hooks(partialLaunch("tc-late", "job-late"), w.hookCtx); // 65th: retained, not admitted
		await tick();
		await w.hooks(jobDone(["job-late"]), w.hookCtx);
		const r1 = await w.loop();
		expect(r1.gapKinds).toContain("gate_state_dropped");
		expect((await fs.readdir(await eventsDir(w))).some(f => f.includes("-quiescence-"))).toBe(true);
		expect((await fs.readdir(await eventsDir(w))).some(f => f.includes("-launch-"))).toBe(true);
	}, 60_000);

	it("a step-9 admitted partial gate gets its quiescence and is clean on the next run", async () => {
		const w = await world();
		await w.run();
		await tick();
		const ids = Array.from({ length: 64 }, (_, i) => `job-${i}`);
		for (const [i, id] of ids.entries()) await w.hooks(launchResult(`tc${i}`, [id]), w.hookCtx);
		await w.hooks(partialLaunch("tc-late", "job-late"), w.hookCtx);
		await tick();
		await w.hooks(jobDone([...ids, "job-late"]), w.hookCtx);
		const r1 = await w.loop();
		expect(r1.openGates).toBe(1);
		expect(r1.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		const r2 = await w.loop();
		expect(r2).toMatchObject({ status: "clean", openGates: 0, resolvedGates: 65 });
	}, 60_000);

	it("an OVERFLOW marker is processed first even when 1024 earlier-sorting files fill the directory", async () => {
		const w = await world();
		await w.hooks(launchResult("tc1", ["job-1"]), w.hookCtx);
		const dir = await eventsDir(w);
		for (let i = 0; i < 1024; i++) await fs.writeFile(path.join(dir, `${String(i).padStart(13, "0")}-junk`), "");
		const epoch = 1_600_000_000_000; // older than the activation floor: it must lower the floor
		await fs.writeFile(path.join(dir, `OVERFLOW-${epoch}-abcd1234`), "");
		const d = await w.loop();
		expect(d.status).toBe("gaps");
		expect(d.gapKinds).toContain("scan_truncated"); // unmerged events are reported, never silently clean
		expect((await ledgerOf(w)).body.scan.floor).toBe(epoch - 2000);
		expect((await fs.readdir(dir)).some(f => f.startsWith("OVERFLOW-"))).toBe(false); // reconciled by the complete walk
	});
});

describe("verification_loop: real in-memory SessionManager walk (AC15/AC16)", () => {
	interface Real {
		w: World;
		sm: SessionManager;
		facade: ReturnType<typeof createReadonlySessionManager>;
		stats: () => ReturnType<SessionManager["getObservabilityStatsForTests"]>;
		launch: (toolCallId: string, jobIds: string[]) => string;
		result: (toolName: string, toolCallId: string, details: unknown) => string;
		user: (n: number) => void;
		run: () => ReturnType<Installed["run"]["executeRun"]>;
		loop: (
			deps?: Parameters<Installed["loop"]["executeLoop"]>[2],
			view?: unknown,
		) => ReturnType<Installed["loop"]["executeLoop"]>;
	}
	async function real(): Promise<Real> {
		const w = await world();
		const sm = SessionManager.inMemory(w.repo);
		const facade = createReadonlySessionManager(sm);
		const pi = mkPi(w.repo, w.env);
		const tool = (toolName: string, toolCallId: string, details: unknown, text = "ok") =>
			sm.appendMessage({
				role: "toolResult",
				toolName,
				toolCallId,
				content: [{ type: "text", text }],
				details,
				isError: false,
				timestamp: Date.now(),
			} as never);
		return {
			w,
			sm,
			facade,
			stats: () => sm.getObservabilityStatsForTests(),
			launch: (toolCallId, jobIds) => {
				sm.appendMessage({
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: {} }],
					timestamp: Date.now(),
				} as never);
				const text = `Started ${jobIds.length} background task jobs using agent.\n${jobIds.map((j, i) => `- \`sub${i}\` (job \`${j}\`)`).join("\n")}\n`;
				return tool("task", toolCallId, { async: { state: "running", jobId: jobIds[0], type: "task" } }, text);
			},
			result: (toolName, toolCallId, details) => tool(toolName, toolCallId, details),
			user: n => {
				for (let i = 0; i < n; i++)
					sm.appendMessage({ role: "user", content: "x", timestamp: Date.now() } as never);
			},
			run: () =>
				w.m.run.executeRun(
					pi,
					{ sessionManager: facade },
					`run-${Math.random()}`,
					{ files: ["a.test.ts"] },
					undefined,
					{ env: w.env.env },
					w.env.toolsDir,
				),
			loop: (deps, view) =>
				w.m.loop.executeLoop(
					pi,
					{ sessionManager: (view ?? facade) as never },
					{ env: w.env.env, ...deps },
					w.env.toolsDir,
				),
		};
	}

	it("reconstructs launch -> async-result -> receipt -> clean; getBranch is never materialized and getEntry stays bounded", async () => {
		const r = await real();
		r.launch("tc1", ["job-1"]);
		const before = r.stats();
		const d1 = await r.loop();
		const after = r.stats();
		expect(d1.gapKinds).toEqual(["delegation_terminal_unobserved"]);
		expect(d1.transcript.reconstructedGates).toBe(1);
		expect(after.getBranchMaterializerCallCount - before.getBranchMaterializerCallCount).toBe(0);
		const calls = after.getEntryMaterializerCallCount - before.getEntryMaterializerCallCount;
		expect(calls).toBeGreaterThanOrEqual(2); // the walk really goes through getEntry
		expect(calls).toBeLessThanOrEqual(r.w.m.loop.WALK_CAP + 2);
		await tick();
		r.sm.appendCustomMessageEntry("async-result", "done", true, { jobs: [{ jobId: "job-1", type: "task" }] });
		expect((await r.loop()).gapKinds).toEqual(["no_receipt_after_terminal"]);
		await r.run();
		expect((await r.loop()).status).toBe("clean");
		expect(r.stats().getBranchMaterializerCallCount).toBe(before.getBranchMaterializerCallCount);
	});

	it("WALK_CAP=10 with 15 new entries: run 1 truncated (no gate, pending), run 2 skips the segment and completes", async () => {
		const r = await real();
		r.launch("tc1", ["job-1"]); // 2 entries
		r.user(13);
		const s0 = r.stats().getEntryMaterializerCallCount;
		const r1 = await r.loop({ walkCap: 10 });
		const s1 = r.stats().getEntryMaterializerCallCount;
		expect(r1).toMatchObject({ status: "gaps", openGates: 0, transcript: { truncated: true, pendingSegment: true } });
		expect(r1.gapKinds).toEqual(["scan_truncated"]);
		expect(s1 - s0).toBeLessThanOrEqual(10 + 2);
		const r2 = await r.loop({ walkCap: 10 });
		const s2 = r.stats().getEntryMaterializerCallCount;
		expect(r2.transcript).toMatchObject({ truncated: false, pendingSegment: false, reconstructedGates: 1 });
		expect(s2 - s1).toBeLessThanOrEqual(10 + 2);
		expect(r2.gapKinds).toEqual(["delegation_terminal_unobserved"]);
	});

	it("an invalid stored pending bottomId resets the scan instead of reporting a complete walk", async () => {
		const r = await real();
		r.launch("tc1", ["job-1"]);
		r.user(13);
		await r.loop({ walkCap: 10 });
		const root = path.join(r.w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(root);
		const dir = path.join(root, repoDir as string);
		const file = path.join(dir, (await fs.readdir(dir)).find(f => f.endsWith(".json")) as string);
		const ledger = JSON.parse(await fs.readFile(file, "utf8"));
		expect(ledger.scan.pending).not.toBeNull();
		ledger.scan.pending.bottomId = "no-such-entry";
		await fs.writeFile(file, JSON.stringify(ledger));
		const d = await r.loop({ walkCap: 100 });
		expect(d.transcript.reconstructedGates).toBe(1); // the launch below the bogus segment is still found
		expect(d.gapKinds).toEqual(["delegation_terminal_unobserved"]);
		expect(JSON.parse(await fs.readFile(file, "utf8")).scan.pending).toBeNull();
	});

	it("an unresolvable entry id mid-chain is truncated (never complete) and recovers once it resolves", async () => {
		const r = await real();
		r.launch("tc1", ["job-1"]);
		r.user(4);
		const ids: string[] = [];
		for (let id = r.facade.getLeafId(); id; ) {
			ids.push(id);
			id = (r.facade.getEntry(id) as unknown as { parentId: string | null }).parentId;
		}
		const hidden = ids[2] as string; // third from the leaf
		const blind = { ...r.facade, getEntry: (id: string) => (id === hidden ? undefined : r.facade.getEntry(id)) };
		const d1 = await r.loop({}, blind);
		expect(d1.status).toBe("gaps");
		expect(d1.gapKinds).toEqual(["scan_truncated"]);
		expect(d1.warnings).toContain("transcript_entry_unresolved");
		expect(d1.openGates).toBe(0);
		const d2 = await r.loop();
		expect(d2.transcript).toMatchObject({ truncated: false, reconstructedGates: 1 });
		expect(d2.gapKinds).toEqual(["delegation_terminal_unobserved"]);
	});

	it("gate-keyed shapes through a real transcript: queued subagent resume, task job discovery and job-list typing", async () => {
		const r = await real();
		r.result("subagent", "s1", { subagents: [{ id: "agent-q", jobId: "job-q", status: "queued" }] });
		r.result("job", "j1", {
			jobs: [
				{ id: "bash-1", type: "bash", status: "running" },
				{ id: "task-1", type: "task", status: "running" },
			],
			cancelled: [{ id: "task-gone", status: "cancelled" }],
		});
		const d = await r.loop();
		// queued resume + the running *task* job open gates; the running bash job and the cancelled item do not
		expect(d.gates.map(g => g.trigger).sort()).toEqual(["discovered", "subagent_resume"]);
		expect(d.openGates).toBe(2);
	});
});

describe("verification_loop: admission, overflow and R-clear", () => {
	it("65 launches: 64 stored, the 65th retained, then absorbed after resolution and evaluated next run (R3)", async () => {
		const w = await world();
		await w.run();
		await tick();
		const ids = Array.from({ length: 65 }, (_, i) => `job-${i}`);
		for (const [i, id] of ids.entries()) await w.hooks(launchResult(`tc${i}`, [id]), w.hookCtx);
		await tick();
		await w.hooks(jobDone(ids), w.hookCtx);
		// first run: the stored gates are resolved (no_change); the retained one is absorbed at step 9 and not evaluated yet
		const r1 = await w.loop();
		expect(r1.status).toBe("gaps");
		expect(r1.resolvedGates).toBe(64);
		expect(r1.openGates).toBe(1);
		expect(r1.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		expect(r1.overflow).toBeNull();
		expect(r1.notes).toContain("overflow_cleared");
		const r2 = await w.loop();
		expect(r2).toMatchObject({ status: "clean", openGates: 0, resolvedGates: 65 });
	}, 60_000);

	it("a full open set keeps overflow, never reports clean and counts pending keys", async () => {
		const w = await world();
		for (let i = 0; i < 65; i++) await w.hooks(launchResult(`tc${i}`, [`job-${i}`]), w.hookCtx);
		const d = await w.loop();
		expect(d.openGates).toBe(64);
		expect(d.status).toBe("gaps");
		expect(d.gapKinds).toContain("gate_state_dropped");
		expect(d.overflow).toEqual({ pendingKeys: 1, keysTruncated: false });
		const again = await w.loop();
		expect(again.gapKinds).toContain("gate_state_dropped");
		expect(again.overflow?.pendingKeys).toBe(1);
	}, 60_000);

	it("(R3) an unabsorbed transcript launch keeps pending null; once absorbed its async-result is re-met", async () => {
		const w = await world();
		await w.run();
		await tick();
		const ids = Array.from({ length: 64 }, (_, i) => `job-${i}`);
		for (const [i, id] of ids.entries()) await w.hooks(launchResult(`tc${i}`, [id]), w.hookCtx);
		await tick();
		w.session.launch("tcU", ["job-U"]);
		await tick();
		w.session.asyncResult(["job-U"]);
		const r1 = await w.loop();
		expect(r1.gapKinds).toContain("gate_state_dropped");
		expect(r1.transcript.pendingSegment).toBe(false);
		const ledgerRoot = path.join(w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(ledgerRoot);
		const ledgerFile = (await fs.readdir(path.join(ledgerRoot, repoDir as string))).find(f =>
			f.endsWith(".json"),
		) as string;
		const ledger = JSON.parse(await fs.readFile(path.join(ledgerRoot, repoDir as string, ledgerFile), "utf8"));
		expect(ledger.scan.pending).toBeNull();
		expect(ledger.scan.cursor).toBeNull();
		expect(ledger.overflow.pendingKeys).toHaveLength(1);
		await tick();
		await w.hooks(jobDone(ids), w.hookCtx);
		const r2 = await w.loop();
		expect(r2.resolvedGates).toBe(64);
		expect(r2.gapKinds).toContain("delegation_terminal_unobserved");
		const r3 = await w.loop();
		expect(r3).toMatchObject({
			status: "clean",
			resolvedGates: 65,
			newlyResolved: 1,
			transcript: { reconstructedGates: 0, pendingSegment: false },
		});
		expect(r3.transcript.walkedEntries).toBeGreaterThan(0);
		expect(r3.gates[0]).toMatchObject({
			origin: "transcript",
			jobs: { total: 1, terminal: 1 },
			resolution: "no_change",
		});
	}, 60_000);
});

describe("verification_loop: blocked states and tool surface", () => {
	it("not a repository, store busy and invalid ledger are blocked with closed reasons", async () => {
		const w = await world();
		const plain = await mkTemp("skc-vr-plain-");
		const m = w.m;
		const bad = await m.loop.executeLoop(
			mkPi(plain, w.env),
			{ sessionManager: w.session },
			{ env: w.env.env },
			w.env.toolsDir,
		);
		expect(bad).toMatchObject({ status: "blocked", reason: "not_a_repository" });
		await w.loop();
		const ledgerRoot = path.join(w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(ledgerRoot);
		const dir = path.join(ledgerRoot, repoDir as string);
		const ledgerFile = (await fs.readdir(dir)).find(f => f.endsWith(".json")) as string;
		const lock = path.join(dir, ledgerFile.replace(/\.json$/, ".lock"));
		await fs.writeFile(lock, JSON.stringify({ v: 1, pid: process.pid, createdAt: Date.now(), nonce: "n" }), {
			mode: 0o600,
		});
		const busy = await w.loop();
		expect(busy).toMatchObject({ status: "blocked", reason: "store_busy" });
		await fs.unlink(lock);
		await fs.chmod(path.join(dir, ledgerFile), 0o600);
		await fs.writeFile(path.join(dir, ledgerFile), "{not json");
		expect(await w.loop()).toMatchObject({ status: "blocked", reason: "state_unavailable" });
	});

	it("a dead-pid stale lock is broken and the loop proceeds", async () => {
		const w = await world();
		await w.loop();
		const ledgerRoot = path.join(w.env.storeRoot, "ledger", "v1");
		const [repoDir] = await fs.readdir(ledgerRoot);
		const dir = path.join(ledgerRoot, repoDir as string);
		const ledgerFile = (await fs.readdir(dir)).find(f => f.endsWith(".json")) as string;
		await fs.writeFile(
			path.join(dir, ledgerFile.replace(/\.json$/, ".lock")),
			JSON.stringify({ v: 1, pid: 2_147_483_000, createdAt: Date.now(), nonce: "n" }),
			{ mode: 0o600 },
		);
		expect((await w.loop()).status).toBe("clean");
	});

	it("the tool is strict with no parameters and returns identical content and details", async () => {
		const w = await world();
		const tool = w.m.loop.default(mkPi(w.repo, w.env));
		expect(tool.name).toBe("verification_loop");
		expect(tool.parameters.safeParse({}).success).toBe(true);
		expect(tool.parameters.safeParse({ x: 1 }).success).toBe(false);
		const res = await tool.execute("t", {}, undefined, { sessionManager: w.session });
		expect(JSON.parse(res.content[0]?.text as string)).toEqual(res.details as never);
	});
});

describe("verification_loop: QA red-team regressions", () => {
	const RESUME = "subagent";
	const queuedSnapshot = (id: string, jobId: string) => ({ subagents: [{ id, jobId, status: "queued" }] });

	it("BLK-1: a queued resume of a job id that is only terminal in an open gate opens its own gate", async () => {
		const w = await world();
		w.session.launch("tc1", ["0-A"]);
		await tick();
		w.session.asyncResult(["0-A"]);
		await tick();
		w.session.result(RESUME, "s1", queuedSnapshot("0-A", "0-A"));
		await tick();
		await w.run();
		await w.hooks(jobDone(["0-A"]), w.hookCtx); // quiescence after the queued snapshot
		const d = await w.loop();
		expect(d.status).toBe("gaps");
		const resume = d.gates.find(g => g.trigger === "subagent_resume");
		expect(resume).toMatchObject({ jobSetComplete: false, jobs: { total: 0, terminal: 0 } });
		expect(resume?.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		expect(d.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		// the launch gate itself still resolves from the passing receipt
		expect(d.gates.find(g => g.trigger === "task_launch")?.resolution).toBe("receipts");
	});

	it("BLK-1: the resumed run must be terminal-observed (and verified) before the loop reports clean", async () => {
		const w = await world();
		w.session.launch("tc1", ["0-A"]);
		await tick();
		w.session.asyncResult(["0-A"]);
		await tick();
		w.session.result(RESUME, "s1", queuedSnapshot("0-A", "0-A"));
		await tick();
		await w.run();
		expect((await w.loop()).status).toBe("gaps");
		// the resumed job starts under a new job id, edits code and finishes
		w.session.result(RESUME, "s2", { subagents: [{ id: "0-A", jobId: "0-A-resume", status: "running" }] });
		await tick();
		await write(w.repo, "a.ts", "export const a = 11;\n");
		w.session.asyncResult(["0-A-resume"]);
		await tick();
		w.session.result(RESUME, "s3", { subagents: [{ id: "0-A", jobId: "0-A-resume", status: "completed" }] });
		await tick();
		const afterEdit = await w.loop();
		expect(afterEdit.status).toBe("gaps"); // quiescence not observed yet
		await w.hooks(jobDone(["0-A", "0-A-resume"]), w.hookCtx);
		await tick();
		expect((await w.loop()).gapKinds).toEqual(["no_receipt_after_terminal"]);
		await w.run();
		const clean = await w.loop();
		expect(clean).toMatchObject({ status: "clean", openGates: 0 });
		// a resolved resume gate is not re-opened by the replayed snapshot
		expect((await w.loop()).status).toBe("clean");
	});

	it("R3-1 (F2): a queued snapshot always opens a resume gate, even while the prior job is still running; replay does not reopen it", async () => {
		const w = await world();
		w.session.launch("tc1", ["0-A"]);
		await tick();
		w.session.result(RESUME, "s1", queuedSnapshot("0-A", "0-A"));
		const d = await w.loop();
		expect(d.openGates).toBe(2);
		expect(d.gates.map(g => g.trigger)).toEqual(["task_launch", "subagent_resume"]);
		// the same queued snapshot again (second queued result for the same subagent) dedupes against the open resume gate
		w.session.result(RESUME, "s1b", queuedSnapshot("0-A", "0-A"));
		expect((await w.loop()).openGates).toBe(2);
		w.session.result(RESUME, "s2", { subagents: [{ id: "0-A", jobId: "0-A-resume", status: "running" }] });
		w.session.asyncResult(["0-A", "0-A-resume"]);
		await tick();
		w.session.result(RESUME, "s3", { subagents: [{ id: "0-A", jobId: "0-A-resume", status: "completed" }] });
		await tick();
		await w.hooks(jobDone(["0-A", "0-A-resume"]), w.hookCtx);
		await tick();
		await w.run();
		expect(await w.loop()).toMatchObject({ status: "clean", openGates: 0 });
		expect(await w.loop()).toMatchObject({ status: "clean", openGates: 0 }); // replay of the whole transcript reopens nothing
	});

	const hookEvent = (toolName: string, toolCallId: string, details: unknown, input: unknown = {}) => ({
		toolName,
		toolCallId,
		isError: false,
		input,
		content: [],
		details,
	});
	// R3-1: launch -> (optional loop) -> queued resume of the same job id BEFORE its async-result -> async-result ->
	// passing receipt -> the resumed run edits a.ts and ends -> loop. It may never report clean.
	const queuedBeforePriorTerminal = async (mode: { hook: boolean; loopBetween: boolean }) => {
		const w = await world();
		w.session.launch("tc1", ["0-t1"]);
		if (mode.hook) await w.hooks(launchResult("tc1", ["0-t1"]), w.hookCtx);
		await tick();
		if (mode.loopBetween) expect((await w.loop()).gates.map(g => g.trigger)).toEqual(["task_launch"]);
		const snap = queuedSnapshot("sub0", "0-t1");
		w.session.result(RESUME, "sr1", snap);
		if (mode.hook) await w.hooks(hookEvent("subagent", "sr1", snap, { action: "resume" }), w.hookCtx);
		await tick();
		w.session.asyncResult(["0-t1"]);
		await tick();
		await w.run();
		const first = await w.loop();
		expect(first.status).toBe("gaps");
		expect(first.gates.map(g => g.trigger)).toEqual(["task_launch", "subagent_resume"]);
		expect(first.gates[0]?.resolution).toBe("receipts");
		expect(first.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
		await write(w.repo, "a.ts", "export const a = 99;\n");
		w.session.asyncResult(["0-t1-resume-0123456789abcdef"]);
		await tick();
		const second = await w.loop();
		expect(second.status).toBe("gaps");
		expect(second.gates.find(g => g.trigger === "subagent_resume")?.gapKinds).toContain(
			"delegation_terminal_unobserved",
		);
		return w;
	};
	it("R3-1: queued resume before the prior job's async-result is never clean (hook path)", async () => {
		await queuedBeforePriorTerminal({ hook: true, loopBetween: false });
	});
	it("R3-1: queued resume before the prior job's async-result is never clean (transcript only)", async () => {
		await queuedBeforePriorTerminal({ hook: false, loopBetween: false });
	});
	it("R3-1: queued resume before the prior job's async-result is never clean (after a loop run)", async () => {
		await queuedBeforePriorTerminal({ hook: false, loopBetween: true });
	});
	it("R4-B2: a listing of the prior job's own `cancelled` status never closes the queued-resume gate", async () => {
		const w = await world();
		const listing = (jobs: Array<{ id: string; type: string; status: string }>, toolCallId: string) => {
			const details = { jobs };
			w.session.result("job", toolCallId, details);
			return w.hooks(
				{ toolName: "job", toolCallId, isError: false, input: { list: true }, content: [], details },
				w.hookCtx,
			);
		};
		w.session.launch("tc1", ["0-t1"]);
		await w.hooks(launchResult("tc1", ["0-t1"]), w.hookCtx);
		await tick();
		await listing([{ id: "0-t1", type: "task", status: "cancelled" }], "jl0"); // J1 is cancelled before the resume
		await tick();
		// the resume queues behind full async slots (non-task jobs only), so nothing runs yet
		const snap = queuedSnapshot("sub0", "0-t1");
		w.session.result(RESUME, "sr1", snap);
		await w.hooks(hookEvent("subagent", "sr1", snap, { action: "resume" }), w.hookCtx);
		await tick();
		// a later listing repeats J1 as cancelled next to a running non-task job: quiescence for tasks, but still
		// no observation of the resumed run
		await listing(
			[
				{ id: "0-t1", type: "task", status: "cancelled" },
				{ id: "bash-1", type: "bash", status: "running" },
			],
			"jl1",
		);
		await tick();
		await w.run();
		const first = await w.loop();
		expect(first.status).toBe("gaps");
		const resume = first.gates.find(g => g.trigger === "subagent_resume");
		expect(resume?.gapKinds).toContain("delegation_terminal_unobserved");
		// the slots drain, the resumed run edits code and is seen only through its async-result
		await write(w.repo, "a.ts", "export const a = 77;\n");
		w.session.asyncResult(["0-t1-resume"]);
		await tick();
		const second = await w.loop();
		expect(second.status).toBe("gaps");
		expect(second.gates.find(g => g.trigger === "subagent_resume")?.gapKinds).toContain(
			"delegation_terminal_unobserved",
		);
		// only once the resumed run itself is observed terminal (and verified) does the loop close
		const done = { subagents: [{ id: "sub0", jobId: "0-t1-resume", status: "completed" }] };
		w.session.result(RESUME, "sr2", done);
		await w.hooks(hookEvent("subagent", "sr2", done, { action: "resume" }), w.hookCtx);
		await tick();
		await w.hooks(jobDone(["0-t1", "0-t1-resume"]), w.hookCtx);
		await tick();
		await w.run();
		expect(await w.loop()).toMatchObject({ status: "clean", openGates: 0 });
	});

	it("BLK-4: a duplicated listing line hidden behind 64 KiB of padding keeps the job set partial", async () => {
		const w = await world();
		const text = `Started 2 background task jobs using agent.\n- \`0-A\` (job \`0-A\`) \u2014 x\n- \`0-A\` (job \`0-A\`)\n${"y".repeat(70_000)}\n- \`0-B\` (job \`0-B\`)\n`;
		w.session.launch("tc1", ["0-A", "0-B"], text);
		await tick();
		w.session.asyncResult(["0-A"]);
		await tick();
		await write(w.repo, "a.ts", "export const a = 12;\n");
		await w.run();
		const d = await w.loop();
		expect(d.status).toBe("gaps");
		expect(d.gates[0]).toMatchObject({ jobSetComplete: false });
		expect(d.gapKinds).toEqual(["delegation_terminal_unobserved", "delegation_job_set_partial"]);
	});

	it("BLK-4: parseLaunchText is only complete for a unique, in-window listing", async () => {
		const { parseLaunchText } = (await world()).m.gate;
		const line = (id: string, job: string) => `- \`${id}\` (job \`${job}\`)`;
		const head = (n: number) => `Started ${n} background task jobs using agent.`;
		const ok = parseLaunchText(`${head(2)}\n${line("a", "0-A")}\n${line("b", "0-B")}\n`, "0-A");
		expect(ok).toMatchObject({ complete: true, expected: 2 });
		const dup = parseLaunchText(`${head(2)}\n${line("a", "0-A")}\n${line("a2", "0-A")}\n`, "0-A");
		expect(dup.complete).toBe(false);
		expect(dup.jobs.map(j => j.jobId)).toEqual(["0-A"]);
		const padded = parseLaunchText(
			`${head(2)}\n${line("a", "0-A")}\n${line("b", "0-B")}\n${"y".repeat(70_000)}`,
			"0-A",
		);
		expect(padded.complete).toBe(false);
		const extra = parseLaunchText(
			`${head(2)}\n${line("a", "0-A")}\n${line("b", "0-B")}\n${line("c", "0-C")}\n`,
			"0-A",
		);
		expect(extra.complete).toBe(false);
	});

	it("AC14 (D-6): through the host's validateToolArguments unknown keys never reach execute and bad types are rejected first", async () => {
		const w = await world();
		const pi = mkPi(w.repo, w.env);
		const tools = {
			loop: w.m.loop.default(pi),
			run: w.m.run.default(pi),
			status: w.m.status.default(pi),
		};
		let calls: unknown[] = [];
		const host = (tool: (typeof tools)[keyof typeof tools], args: Record<string, unknown>) => {
			calls = [];
			const execute = (...a: unknown[]) => {
				calls.push(a[1]);
				return undefined;
			};
			let validated: Record<string, unknown>;
			try {
				validated = validateToolArguments(tool as never, {
					type: "toolCall",
					id: "t1",
					name: tool.name,
					arguments: args,
				}) as Record<string, unknown>;
			} catch {
				return "rejected" as const;
			}
			execute("t1", validated);
			return "executed" as const;
		};
		const uuid = "123e4567-e89b-42d3-a456-426614174000";
		// unknown keys are stripped (D-6), never forwarded
		expect(host(tools.loop, { x: 1 })).toBe("executed");
		expect(calls).toEqual([{}]);
		expect(host(tools.run, { files: ["a.test.ts"], timeoutMs: 5000, cwd: "/", command: "rm -rf /" })).toBe(
			"executed",
		);
		expect(calls).toEqual([{ files: ["a.test.ts"], timeoutMs: 5000 }]);
		expect(host(tools.status, { receiptId: uuid, extra: true })).toBe("executed");
		expect(calls).toEqual([{ receiptId: uuid }]);
		// type and range violations are rejected before execute
		for (const bad of [
			{},
			{ files: "a.test.ts" },
			{ files: [1] },
			{ files: ["a.test.ts"], timeoutMs: 10 },
			{ files: ["a.test.ts"], timeoutMs: 10_000_000 },
			{ files: ["a.test.ts"], runner: "jest" },
		]) {
			expect(host(tools.run, bad)).toBe("rejected");
			expect(calls).toEqual([]);
		}
		for (const bad of [{}, { receiptId: "nope" }, { receiptId: 7 }]) {
			expect(host(tools.status, bad)).toBe("rejected");
			expect(calls).toEqual([]);
		}
	});

	/** A session whose cwd is `<repo>/pkg`, in a repo that also has code outside it (BLK-2). */
	async function subdirWorld() {
		const w = await world();
		await write(w.repo, "pkg/p.test.ts", PASS_TEST);
		await write(w.repo, "pkg/x.ts", "export const x = 1;\n");
		await write(w.repo, "lib/l.ts", "export const l = 1;\n");
		await git(w.repo, "add", "-A");
		await git(w.repo, "commit", "-q", "-m", "layout");
		const pi = mkPi(path.join(w.repo, "pkg"), w.env);
		const ctx = { sessionManager: w.session };
		return {
			w,
			run: (files: string[]) =>
				w.m.run.executeRun(
					pi,
					ctx,
					`run-${Math.random()}`,
					{ files },
					undefined,
					{ env: w.env.env },
					w.env.toolsDir,
				),
			loop: () => w.m.loop.executeLoop(pi, ctx, { env: w.env.env }, w.env.toolsDir),
			status: (receiptId: string) => w.m.status.runStatus(pi, ctx, { receiptId }),
		};
	}
	const observeLaunch = async (w: World) => {
		w.session.launch("tc1", ["job-1"]);
		await tick();
		w.session.asyncResult(["job-1"]);
		await tick();
	};

	it("BLK-2: with cwd in a subdirectory, a skip-worktree edit outside it makes the receipt stale", async () => {
		const s = await subdirWorld();
		await git(s.w.repo, "update-index", "--skip-worktree", "lib/l.ts");
		const r = await s.run(["pkg/p.test.ts"]);
		expect(r).toMatchObject({ execution: { status: "passed" }, freshness: "fresh" });
		expect(r.before?.counts.dirtyPaths).toBe(1); // lib/l.ts is flagged, though it is outside the session cwd
		expect((await s.status(r.receiptId as string)).freshness).toBe("fresh");
		await write(s.w.repo, "lib/l.ts", "export const l = 2;\n");
		expect((await s.status(r.receiptId as string)).freshness).toBe("stale");
	});

	it("BLK-2: with cwd in a subdirectory, an assume-unchanged edit inside it makes the receipt stale", async () => {
		const s = await subdirWorld();
		await git(s.w.repo, "update-index", "--assume-unchanged", "pkg/x.ts");
		const r = await s.run(["pkg/p.test.ts"]);
		await write(s.w.repo, "pkg/x.ts", "export const x = 2;\n");
		expect((await s.status(r.receiptId as string)).freshness).toBe("stale");
	});

	it("BLK-2: with cwd in a subdirectory, staging an already-dirty file outside it makes the receipt stale", async () => {
		const s = await subdirWorld();
		await write(s.w.repo, "lib/l.ts", "export const l = 3;\n");
		const r = await s.run(["pkg/p.test.ts"]);
		expect((await s.status(r.receiptId as string)).freshness).toBe("fresh");
		await git(s.w.repo, "add", "lib/l.ts");
		expect((await s.status(r.receiptId as string)).freshness).toBe("stale");
	});

	it("BLK-2: an untracked test outside the session cwd must be covered (toplevel-relative changed set)", async () => {
		const s = await subdirWorld();
		await observeLaunch(s.w);
		await write(s.w.repo, "lib/new.test.ts", PASS_TEST);
		await s.run(["pkg/p.test.ts"]);
		const d = await s.loop();
		expect(d.status).toBe("gaps");
		expect(d.gapKinds).toEqual(["changed_test_uncovered"]);
		// the null-baseline fallback also lists the just-committed a.test.ts
		expect(d.uncoveredTests).toEqual(["a.test.ts", "lib/new.test.ts"]);
		await s.run(["a.test.ts", "pkg/p.test.ts", "lib/new.test.ts"]);
		expect((await s.loop()).status).toBe("clean");
	});

	it("BLK-2: an untracked test inside the session cwd is reported toplevel-relative and can be covered", async () => {
		const s = await subdirWorld();
		await observeLaunch(s.w);
		await write(s.w.repo, "pkg/new.test.ts", PASS_TEST);
		await s.run(["pkg/p.test.ts"]);
		const d = await s.loop();
		expect(d.uncoveredTests).toEqual(["a.test.ts", "pkg/new.test.ts"]);
		await s.run(["a.test.ts", "pkg/new.test.ts", "pkg/p.test.ts"]);
		expect((await s.loop()).status).toBe("clean");
	});

	it("BLK-2: the committed-since-baseline changed set is toplevel-wide too", async () => {
		const s = await subdirWorld();
		await observeLaunch(s.w);
		await write(s.w.repo, "lib/c.test.ts", PASS_TEST);
		await git(s.w.repo, "add", "-A");
		await git(s.w.repo, "commit", "-q", "-m", "delegate");
		await s.run(["pkg/p.test.ts"]);
		expect((await s.loop()).gapKinds).toEqual(["changed_test_uncovered"]);
	});
});
