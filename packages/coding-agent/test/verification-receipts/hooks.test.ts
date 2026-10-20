import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as baseline from "../../bundles/verification-receipts/hooks/verification-baseline";
import * as gate from "../../bundles/verification-receipts/hooks/verification-gate";
import { BUNDLE, cleanupTemps, git, mkRepo, mkTemp } from "./helpers";

afterEach(cleanupTemps);

describe("hook sources obey the constrained-hooks contract (static scan)", () => {
	const BANNED = [
		"child_process",
		"Bun.spawn",
		"Bun.$",
		".exec(",
		"process.kill",
		"Sync(",
		"pi.exec",
		"sendMessage",
		"appendEntry",
		"import(",
		"require(",
		"fetch(",
		"globalThis",
		"Bun[",
	];
	for (const file of ["verification-gate.ts", "verification-baseline.ts"]) {
		it(`${file} has no banned token, sync fs, tool import or extra ctx member`, async () => {
			const text = await Bun.file(path.join(BUNDLE, "hooks", file)).text();
			for (const token of BANNED) expect(text.includes(token)).toBe(false);
			const imports = [...text.matchAll(/from "([^"]+)"/g)].map(m => m[1]);
			expect(
				imports.every(
					i =>
						i === "node:fs/promises" ||
						i === "node:path" ||
						i === "node:crypto" ||
						i?.startsWith("./verification-"),
				),
			).toBe(true);
			const ctxMembers = new Set([...text.matchAll(/\bctx\.([A-Za-z.]+)/g)].map(m => m[1]));
			expect([...ctxMembers].every(m => m === "cwd" || m === "sessionManager.getSessionId")).toBe(true);
		});
	}
});

async function mkDeps(overrides: Partial<gate.HookDeps> = {}) {
	const store = await mkTemp("skc-vr-hookstore-");
	const root = path.join(store, "data", "verification-receipts");
	await fs.mkdir(path.dirname(root), { mode: 0o700 });
	const warnings: string[] = [];
	let clock = 1_700_000_000_000;
	const deps: gate.HookDeps = {
		fs,
		now: () => clock++,
		sleep: gate.defaultSleep,
		budgetMs: 1500,
		storeRoot: root,
		logger: { warn: m => warnings.push(m) },
		...overrides,
	};
	return { deps, root, warnings };
}

async function eventsOf(root: string, repo: string, session: string): Promise<string[]> {
	const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex(session)));
	return (await fs.readdir(dir).catch(() => [])).sort();
}

const launchEvent = (toolCallId = "tc1", jobIds = ["job-a", "job-b"]) => ({
	toolName: "task",
	toolCallId,
	isError: false,
	input: { isolated: false },
	content: [
		{
			type: "text",
			text: `Started ${jobIds.length} background task jobs using agent.\n${jobIds.map((j, i) => `- \`sub${i}\` (job \`${j}\`)`).join("\n")}\n`,
		},
	],
	details: { async: { state: "running", jobId: jobIds[0] } },
});

describe("task launch gate hook", () => {
	it("records a launch event, appends the advisory text and never changes isError/details", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const event = launchEvent();
		const res = await handler(event, { cwd: repo, sessionManager: { getSessionId: () => "S" } });
		const blocks = res?.content as Array<{ type: string; text: string }>;
		expect(blocks).toHaveLength(2);
		expect(blocks[1]?.text).toMatch(
			/^\[delegation-verification-gate\] gate=[0-9a-f]{8} trigger=task_launch jobs=2 job_set=complete baseline=none isolated=no ledger=recorded/,
		);
		expect(blocks[1]?.text.length).toBeLessThanOrEqual(gate.LAUNCH_TEXT_MAX);
		expect(res).not.toHaveProperty("isError");
		expect(res).not.toHaveProperty("details");
		const files = await eventsOf(root, repo, "S");
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^\d{13}-launch-[0-9a-f]{8}\.json$/);
		const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
		const body = await Bun.file(path.join(dir, files[0] as string)).text();
		expect(body).not.toContain("job-a");
		expect(body).not.toContain("tc1");
		expect(JSON.parse(body)).toMatchObject({
			kind: "launch",
			key: gate.taskGateKey("tc1"),
			complete: true,
			expected: 2,
		});
		expect((await fs.stat(path.join(dir, files[0] as string))).mode & 0o777).toBe(0o600);
	});

	it("ignores error results, non-running launches and unknown tools", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		expect(await handler({ ...launchEvent(), isError: true }, ctx)).toBeUndefined();
		expect(
			await handler({ ...launchEvent(), details: { async: { state: "completed", jobId: "x" } } }, ctx),
		).toBeUndefined();
		expect(await handler({ toolName: "read", toolCallId: "r", content: [] }, ctx)).toBeUndefined();
		expect(await eventsOf(root, repo, "S")).toEqual([]);
	});

	it("outside a git repository nothing is written and the launch text says unrecorded", async () => {
		const plain = await mkTemp("skc-vr-plain-");
		const { deps, root } = await mkDeps();
		const res = await gate.createGateHandler(deps)(launchEvent(), {
			cwd: plain,
			sessionManager: { getSessionId: () => "S" },
		});
		expect((res?.content as Array<{ text: string }>)[1]?.text).toContain("ledger=unrecorded");
		expect(await fs.readdir(path.dirname(root))).toEqual([]);
	});

	it("never throws and never stalls when the filesystem fails or hangs", async () => {
		const repo = await mkRepo();
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		const failing = await mkDeps({
			fs: {
				...fs,
				mkdir: async () => {
					throw Object.assign(new Error("EIO"), { code: "EIO" });
				},
			} as unknown as gate.HookFs,
		});
		const r1 = await gate.createGateHandler(failing.deps)(launchEvent(), ctx);
		expect((r1?.content as Array<{ text: string }>)[1]?.text).toContain("ledger=unrecorded");
		const hanging = await mkDeps({
			budgetMs: 80,
			fs: { ...fs, lstat: () => new Promise(() => {}) } as unknown as gate.HookFs,
			sleep: ms => Bun.sleep(ms),
		});
		const started = Date.now();
		const r2 = await gate.createGateHandler(hanging.deps)(launchEvent(), ctx);
		expect(r2).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1500);
	});

	it("a per-file write failure leaves a DROP marker in a writable directory", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const flaky = {
			...fs,
			open: async (file: string, ...rest: unknown[]) => {
				if (path.basename(String(file)).includes("-launch-"))
					throw Object.assign(new Error("EIO"), { code: "EIO" });
				return (fs.open as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
			},
		} as unknown as gate.HookFs;
		const res = await gate.createGateHandler({ ...deps, fs: flaky })(launchEvent(), {
			cwd: repo,
			sessionManager: { getSessionId: () => "S" },
		});
		expect((res?.content as Array<{ text: string }>)[1]?.text).toContain("ledger=unrecorded");
		const files = await eventsOf(root, repo, "S");
		expect(files.some(f => /^DROP-\d{13}-[0-9a-f]{8}$/.test(f))).toBe(true);
	});

	it("writes OVERFLOW instead of an event when the directory is full", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		await gate.createGateHandler(deps)(launchEvent("seed"), ctx);
		const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
		for (let i = 0; i < gate.MAX_EVENT_FILES; i++) await fs.writeFile(path.join(dir, `x${i}`), "");
		const res = await gate.createGateHandler(deps)(launchEvent("tc-over"), ctx);
		expect((res?.content as Array<{ text: string }>)[1]?.text).toContain("ledger=unrecorded");
		expect((await fs.readdir(dir)).some(f => f.startsWith("OVERFLOW-"))).toBe(true);
	});
});

describe("subagent and job hooks", () => {
	it("records observations and appends a reminder once a gated job turns terminal", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		await handler(launchEvent("tcx", ["jx1", "jx2"]), ctx);
		const running = await handler(
			{
				toolName: "subagent",
				toolCallId: "s1",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { subagents: [{ id: "sub0", jobId: "jx1", status: "running" }] },
			},
			ctx,
		);
		expect(running).toBeUndefined();
		const done = await handler(
			{
				toolName: "subagent",
				toolCallId: "s2",
				isError: false,
				content: [{ type: "text", text: "ok" }],
				details: { subagents: [{ id: "sub0", jobId: "jx1", status: "completed" }] },
			},
			ctx,
		);
		const text = (done?.content as Array<{ text: string }>)[1]?.text;
		expect(text).toMatch(/^\[delegation-verification-gate\] gate=[0-9a-f]{8} terminal=1\/2: call verification_loop/);
		expect(text?.length).toBeLessThanOrEqual(gate.REMINDER_TEXT_MAX);
		const jobRes = await handler(
			{
				toolName: "job",
				toolCallId: "j1",
				isError: false,
				input: { list: true },
				content: [{ type: "text", text: "ok" }],
				details: {
					jobs: [
						{ id: "jx1", type: "task", status: "completed" },
						{ id: "jx2", type: "task", status: "completed" },
					],
				},
			},
			ctx,
		);
		expect(jobRes).toBeDefined();
		const kinds = (await eventsOf(root, repo, "S")).map(f => f.split("-")[1]);
		expect(kinds.sort()).toEqual(["job", "launch", "quiescence", "subagent", "subagent"]);
	});

	it("does not record quiescence while a task job is still running or for a non-list call", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		await handler(
			{
				toolName: "job",
				toolCallId: "j1",
				isError: false,
				input: { list: true },
				content: [],
				details: { jobs: [{ id: "a", type: "task", status: "running" }] },
			},
			ctx,
		);
		await handler(
			{
				toolName: "job",
				toolCallId: "j2",
				isError: false,
				input: { poll: ["a"] },
				content: [],
				details: { jobs: [{ id: "a", type: "task", status: "completed" }] },
			},
			ctx,
		);
		const kinds = (await eventsOf(root, repo, "S")).map(f => f.split("-")[1]);
		expect(kinds).toEqual(["job", "job"]);
	});

	it("records quiescence for an empty job listing but not when details carry no jobs array", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		const listing = (toolCallId: string, details: unknown) =>
			handler({ toolName: "job", toolCallId, isError: false, input: { list: true }, content: [], details }, ctx);
		await listing("j0", {});
		expect(await eventsOf(root, repo, "S")).toEqual([]);
		await listing("j1", { jobs: [] });
		const kinds = (await eventsOf(root, repo, "S")).map(f => f.split("-")[1]);
		expect(kinds).toEqual(["quiescence"]);
	});

	it("fails closed on truncated or unparsable task job listings", () => {
		const done = { id: "d", type: "task", status: "completed" };
		expect(gate.jobItems({ jobs: [done] }).activeTaskJob).toBe(false);
		expect(gate.jobItems({ jobs: [done, { type: "task", status: "completed" }] }).activeTaskJob).toBe(true);
		expect(gate.jobItems({ jobs: [done, "garbage"] }).activeTaskJob).toBe(true);
		expect(gate.jobItems({ jobs: [{ type: "bash", status: "running" }] }).activeTaskJob).toBe(false);
		const many = Array.from({ length: 257 }, (_, i) => ({ ...done, id: `d${i}` })); // 4 * MAX_JOB_LINES + 1
		expect(gate.jobItems({ jobs: many }).activeTaskJob).toBe(true);
		expect(gate.jobItems({ jobs: [] })).toEqual({ items: [], activeTaskJob: false, listed: true });
		expect(gate.jobItems({}).listed).toBe(false);
	});

	it("hook events and transcript facts come from the same extractor (typing, closed status set, digests)", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		const jobDetails = {
			jobs: [
				{ id: "bash-1", type: "bash", status: "running" },
				{ id: "task-1", type: "task", status: "inferred" },
			],
			cancelled: [{ id: "task-2", status: "cancelled" }],
		};
		const subDetails = { subagents: [{ id: "a-1", jobId: "j-1", status: "completed_or_failed" }] };
		await handler(
			{ toolName: "job", toolCallId: "tj", isError: false, input: {}, content: [], details: jobDetails },
			ctx,
		);
		await handler({ toolName: "subagent", toolCallId: "ts", isError: false, content: [], details: subDetails }, ctx);
		const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
		const written = new Map<string, Record<string, unknown>>();
		for (const f of await fs.readdir(dir)) {
			const body = JSON.parse(await Bun.file(path.join(dir, f)).text());
			written.set(body.kind, body);
		}
		const entry = (toolName: string, toolCallId: string, details: unknown) => ({
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "toolResult", toolName, toolCallId, isError: false, content: [], details },
		});
		const { obs } = baseline.transcriptFacts([entry("job", "tj", jobDetails), entry("subagent", "ts", subDetails)]);
		const tJob = obs.find(o => o.source === "job");
		const tSub = obs.find(o => o.source === "subagent");
		expect(written.get("job")?.items).toEqual(tJob?.items.map(i => [i.jobD, i.type, i.status]));
		expect(written.get("subagent")?.items).toEqual(tSub?.items.map(i => [i.jobD, i.subD, i.status]));
		expect(written.get("subagent")?.toolCallD).toBe(tSub?.toolCallD as string);
		expect(tJob?.items.map(i => [i.type, i.status])).toEqual([
			["other", "running"],
			["task", "unknown"],
			["task", "cancelled"],
		]);
		expect(tSub?.items[0]?.status).toBe("unknown");
	});

	it("normalizes unknown statuses and ignores error results", async () => {
		const repo = await mkRepo();
		const { deps, root } = await mkDeps();
		const handler = gate.createGateHandler(deps);
		const ctx = { cwd: repo, sessionManager: { getSessionId: () => "S" } };
		await handler(
			{
				toolName: "subagent",
				toolCallId: "s",
				isError: true,
				content: [],
				details: { subagents: [{ id: "a", jobId: "b", status: "running" }] },
			},
			ctx,
		);
		await handler(
			{
				toolName: "subagent",
				toolCallId: "s",
				isError: false,
				content: [],
				details: { subagents: [{ id: "a", jobId: "b", status: "weird<script>" }] },
			},
			ctx,
		);
		const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
		const [file] = await fs.readdir(dir);
		expect(JSON.parse(await Bun.file(path.join(dir, file as string)).text()).items[0][2]).toBe("unknown");
	});
});

describe("baseline hook and HEAD reader", () => {
	it("records the HEAD sha from the filesystem before the task runs", async () => {
		const repo = await mkRepo();
		const head = (await git(repo, "rev-parse", "HEAD")).trim();
		const { deps, root } = await mkDeps();
		const res = await baseline.createBaselineHandler(deps)(
			{ toolName: "task", toolCallId: "tcb" },
			{ cwd: repo, sessionManager: { getSessionId: () => "S" } },
		);
		expect(res).toBeUndefined();
		const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
		const [file] = await fs.readdir(dir);
		expect(file).toMatch(/-baseline-/);
		expect(JSON.parse(await Bun.file(path.join(dir, file as string)).text())).toMatchObject({
			head,
			source: "hook_fs",
			toolCallD: gate.d16("tcb"),
		});
	});

	describe("failure, stall and DROP paths (AC12)", () => {
		const hookCtx = (cwd: string) => ({ cwd, sessionManager: { getSessionId: () => "S" } });
		const never = () => new Promise<never>(() => {});

		it("stalled fs.lstat / fs.open: resolves undefined within the budget and warns", async () => {
			const repo = await mkRepo();
			for (const stalled of ["lstat", "open"] as const) {
				const { deps, warnings } = await mkDeps({
					budgetMs: 80,
					sleep: ms => Bun.sleep(ms),
					fs: { ...fs, [stalled]: never } as unknown as gate.HookFs,
				});
				const started = Date.now();
				const res = await baseline.createBaselineHandler(deps)(
					{ toolName: "task", toolCallId: "tcs" },
					hookCtx(repo),
				);
				expect(res).toBeUndefined();
				expect(Date.now() - started).toBeLessThan(80 + 200);
				expect(warnings).toContain("verification-receipts: baseline timed out");
			}
		});

		it("throwing fs: resolves undefined, warns and never throws or blocks", async () => {
			const repo = await mkRepo();
			const { deps, warnings } = await mkDeps({
				fs: {
					...fs,
					realpath: async () => {
						throw Object.assign(new Error("EIO"), { code: "EIO" });
					},
				} as unknown as gate.HookFs,
			});
			const res = await baseline.createBaselineHandler(deps)({ toolName: "task", toolCallId: "tct" }, hookCtx(repo));
			expect(res).toBeUndefined();
			expect(warnings).toContain("verification-receipts: baseline failed");
		});

		it("a corrupt HEAD leaves a DROP marker and a warning, and still resolves undefined", async () => {
			const repo = await mkRepo();
			await fs.writeFile(path.join(repo, ".git", "HEAD"), "not-a-ref\n");
			const { deps, root, warnings } = await mkDeps();
			const res = await baseline.createBaselineHandler(deps)({ toolName: "task", toolCallId: "tcd" }, hookCtx(repo));
			expect(res).toBeUndefined();
			expect(warnings).toContain("verification-receipts: baseline failed");
			const files = await eventsOf(root, repo, "S");
			expect(files.some(f => /^DROP-\d{13}-[0-9a-f]{8}$/.test(f))).toBe(true);
			expect(files.some(f => f.includes("-baseline-"))).toBe(false);
		});

		it("an unrecorded baseline event (full directory) is a DROP, not a silent success", async () => {
			const repo = await mkRepo();
			const { deps, root, warnings } = await mkDeps();
			const ctx = hookCtx(repo);
			await baseline.createBaselineHandler(deps)({ toolName: "task", toolCallId: "seed" }, ctx);
			const dir = path.join(root, ...gate.eventsParts(gate.sha256Hex(await fs.realpath(repo)), gate.sha256Hex("S")));
			for (let i = 0; i < gate.MAX_EVENT_FILES; i++) await fs.writeFile(path.join(dir, `x${i}`), "");
			const res = await baseline.createBaselineHandler(deps)({ toolName: "task", toolCallId: "full" }, ctx);
			expect(res).toBeUndefined();
			expect(warnings).toContain("verification-receipts: baseline failed");
			const files = await fs.readdir(dir);
			expect(files.some(f => f.startsWith("OVERFLOW-"))).toBe(true);
			expect(files.some(f => f.startsWith("DROP-"))).toBe(true);
		});
	});

	it("reads loose refs, packed refs, detached HEAD, worktrees and unborn repositories", async () => {
		const repo = await mkRepo();
		const head = (await git(repo, "rev-parse", "HEAD")).trim();
		expect(await baseline.readHeadSha(fs, path.join(repo, ".git"))).toBe(head);
		await git(repo, "pack-refs", "--all");
		await fs.rm(path.join(repo, ".git", "refs", "heads", "main"), { force: true });
		expect(await baseline.readHeadSha(fs, path.join(repo, ".git"))).toBe(head);
		await git(repo, "checkout", "-q", "--detach");
		expect(await baseline.readHeadSha(fs, path.join(repo, ".git"))).toBe(head);
		await git(repo, "checkout", "-q", "main");
		const wt = path.join(await mkTemp("skc-vr-wt-"), "wt");
		await git(repo, "worktree", "add", "-q", "-b", "side", wt);
		const location = await gate.findGitLocation(fs, wt);
		expect(location?.gitDir).toContain("worktrees");
		expect(await baseline.readHeadSha(fs, location?.gitDir as string)).toBe(head);
		const unborn = await mkTemp("skc-vr-unborn-");
		await git(unborn, "init", "-q", "-b", "main");
		expect(await baseline.readHeadSha(fs, path.join(unborn, ".git"))).toBeNull();
	});

	it("rejects a ref that escapes refs/", async () => {
		const repo = await mkRepo();
		await fs.writeFile(path.join(repo, ".git", "HEAD"), "ref: ../../etc/passwd\n");
		await expect(baseline.readHeadSha(fs, path.join(repo, ".git"))).rejects.toThrow();
	});
});

describe("parser fuzz", () => {
	it("parseLaunchText never throws and only ever yields bounded, well-formed ids", () => {
		const seeds = [
			"",
			"Started 1 background task job using x",
			"Started 999 background task jobs using x\n- `a` (job `b`)",
			"- `a` (job `b`)\n".repeat(500),
			"\0\0\0",
			"Started 2 background task jobs using \n- `a`(job `b`)",
		];
		for (let i = 0; i < 300; i++) {
			const text =
				seeds[i % seeds.length]! +
				Math.random()
					.toString(36)
					.repeat(i % 7) +
				(i % 3 === 0 ? "\n- `x` (job `y`)" : "");
			const parsed = gate.parseLaunchText(text, "async-id");
			expect(parsed.jobs.length).toBeGreaterThanOrEqual(1);
			expect(parsed.jobs.length).toBeLessThanOrEqual(64);
			expect(parsed.jobs.some(j => j.jobId === "async-id") || parsed.complete).toBe(true);
			expect(parsed.complete).toBe(parsed.complete && parsed.expected === parsed.jobs.length);
		}
		expect(gate.parseLaunchText(undefined, "j")).toMatchObject({ complete: false, jobs: [{ jobId: "j" }] });
	});
	it("fake listing lines can only make a set partial", () => {
		const text = "Started 2 background task jobs using x\n- `a` (job `j1`)\n- `b` (job `j1`)\n";
		const parsed = gate.parseLaunchText(text, "j2");
		expect(parsed.complete).toBe(false);
	});
	it("bounds prompt text", () => {
		expect(gate.buildReminderText("a".repeat(500), 1, 2).length).toBeLessThanOrEqual(gate.REMINDER_TEXT_MAX);
		expect(
			gate.buildLaunchText({
				gateId8: "abcd1234",
				jobs: 64,
				complete: false,
				baseline: "none",
				isolated: true,
				recorded: false,
			}).length,
		).toBeLessThanOrEqual(gate.LAUNCH_TEXT_MAX);
	});
});
