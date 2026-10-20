/** End-to-end through the installed copy: tool factories, hook handlers and the store, no model. */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pidAlive } from "../../bundles/verification-receipts/tools/verification-status";
import { cleanupTemps, loadInstalled, mkEnv, mkPi, mkRepo, mkTemp, write } from "./helpers";

afterEach(cleanupTemps);

async function walkFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await fs.readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walkFiles(p)));
		else out.push(p);
	}
	return out;
}

describe("E2E through tool factories", () => {
	it("run -> status -> loop via execute(): content JSON equals details, store is private and content-free", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const m = await loadInstalled(env);
		const pi = mkPi(repo, env);
		const SESSION = "very-secret-session-id";
		const ctx = {
			sessionManager: {
				getSessionId: () => SESSION,
				getLeafId: () => null,
				getEntry: () => undefined,
				getHeader: () => null,
			},
		};
		const hookDeps = {
			fs,
			now: () => Date.now(),
			sleep: m.gate.defaultSleep,
			budgetMs: 1500,
			storeRoot: env.storeRoot,
		};
		const gate = m.gate.createGateHandler(hookDeps);
		const base = m.baseline.createBaselineHandler(hookDeps);
		const hookCtx = { cwd: repo, sessionManager: ctx.sessionManager };

		const runTool = m.run.default(pi);
		expect(runTool.parameters.safeParse({ files: ["a.test.ts"], extra: true }).success).toBe(false);
		expect(runTool.parameters.safeParse({ files: ["a.test.ts"], timeoutMs: 999_999 }).success).toBe(false);
		const runRes = await runTool.execute("call-secret-1", { files: ["a.test.ts"] }, undefined, ctx);
		const run = runRes.details;
		expect(JSON.parse(runRes.content[0]?.text as string)).toEqual(run as never);
		expect(run.execution.status).toBe("passed");

		await Bun.sleep(4);
		await base({ toolName: "task", toolCallId: "tc-secret-1" }, hookCtx);
		await gate(
			{
				toolName: "task",
				toolCallId: "tc-secret-1",
				isError: false,
				input: {},
				content: [
					{ type: "text", text: "Started 1 background task job using x.\n- `sub-secret` (job `job-secret-1`)\n" },
				],
				details: { async: { state: "running", jobId: "job-secret-1" } },
			},
			hookCtx,
		);
		await Bun.sleep(4);
		await write(repo, "a.ts", "export const a = 42;\n");
		const reminder = await gate(
			{
				toolName: "subagent",
				toolCallId: "sc",
				isError: false,
				content: [],
				details: { subagents: [{ id: "sub-secret", jobId: "job-secret-1", status: "completed" }] },
			},
			hookCtx,
		);
		expect((reminder?.content as Array<{ text: string }>)[0]?.text).toContain("verification_loop");

		const statusTool = m.status.default(pi);
		const st = await statusTool.execute("s1", { receiptId: run.receiptId as string }, undefined, ctx);
		expect(st.details).toMatchObject({ status: "ok", freshness: "stale", storedFreshness: "fresh" });

		const loopTool = m.loop.default(pi);
		const gaps = await loopTool.execute("l1", {}, undefined, ctx);
		expect(JSON.parse(gaps.content[0]?.text as string)).toEqual(gaps.details as never);
		expect(gaps.details.status).toBe("gaps");
		expect(gaps.details.gapKinds).toEqual(["no_receipt_after_terminal"]);

		await runTool.execute("call-secret-2", { files: ["a.test.ts"] }, undefined, ctx);
		const clean = await loopTool.execute("l2", {}, undefined, ctx);
		expect(clean.details).toMatchObject({ status: "clean", resolvedGates: 1 });

		// AC20: ledger / events / journal hold digests, counts and enums only; everything is private.
		const files = await walkFiles(env.storeRoot);
		expect(files.length).toBeGreaterThan(3);
		const forbidden = [repo, "secret", SESSION, "job-secret", "tc-secret", "a.ts", "passes"];
		for (const f of files) {
			const st = await fs.stat(f);
			expect(st.mode & 0o077).toBe(0);
			if (f.includes(`${path.sep}receipts${path.sep}`)) continue;
			const text = await Bun.file(f).text();
			for (const bad of forbidden) expect(text.includes(bad)).toBe(false);
			if (f.endsWith(".jsonl"))
				for (const line of text.split("\n").filter(Boolean)) expect(line.length).toBeLessThanOrEqual(2048);
		}
		for (const dir of [env.storeRoot, path.join(env.storeRoot, "ledger")])
			expect((await fs.stat(dir)).mode & 0o077).toBe(0);
	}, 60_000);

	it("a runner timeout kills the whole group: both the runner and its grandchild are gone (E2E-6)", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const pids = await mkTemp("skc-vr-pids-");
		await write(
			repo,
			"hang.test.ts",
			`import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("hang", async () => {
	const child = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
	writeFileSync(${JSON.stringify(path.join(pids, "child"))}, String(child.pid));
	writeFileSync(${JSON.stringify(path.join(pids, "runner"))}, String(process.pid));
	await Bun.sleep(100_000);
}, 200_000);
`,
		);
		const m = await loadInstalled(env);
		const tmp = await mkTemp("skc-vr-tmp-");
		const d = await m.run.executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"c",
			{ files: ["hang.test.ts"], timeoutMs: 2500 },
			undefined,
			{ env: { ...env.env, TMPDIR: tmp } },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "timeout" });
		const child = Number(await Bun.file(path.join(pids, "child")).text());
		const runner = Number(await Bun.file(path.join(pids, "runner")).text());
		expect(child).toBeGreaterThan(1);
		expect(pidAlive(child)).toBe(false);
		expect(pidAlive(runner)).toBe(false);
		expect(await fs.readdir(tmp)).toEqual([]);
	}, 30_000);

	it("aborting a run cancels the runner and still stores an incomplete receipt", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(
			repo,
			"slow.test.ts",
			`import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(100_000); }, 200_000);\n`,
		);
		const m = await loadInstalled(env);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1200);
		const d = await m.run.executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"c",
			{ files: ["slow.test.ts"] },
			ac.signal,
			{ env: env.env },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "cancelled" });
		expect(d.storage).toBe("stored");
	}, 30_000);
});
