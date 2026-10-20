import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	boundedSpawn,
	buildEnv,
	makeGitContext,
	pidAlive,
	resolveExecutable,
	runGit,
} from "../../bundles/verification-receipts/tools/verification-status";
import { cleanupTemps, mkTemp } from "./helpers";

afterEach(cleanupTemps);

const env = buildEnv("runner", {
	PATH: process.env.PATH,
	HOME: "/h",
	TMPDIR: "/t",
	SECRET_TOKEN: "x",
	NODE_OPTIONS: "--require evil",
});

async function waitFile(file: string, ms = 5000): Promise<string> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const text = await Bun.file(file)
			.text()
			.catch(() => "");
		if (text.trim()) return text.trim();
		await Bun.sleep(20);
	}
	throw new Error(`timeout waiting for ${file}`);
}

describe("boundedSpawn", () => {
	it("allowlists the runner environment and drops everything else", () => {
		expect(env.SECRET_TOKEN).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.TZ).toBe("UTC");
		expect(env.NO_COLOR).toBe("1");
		const gitEnv = buildEnv("git", { PATH: "/bin", GIT_DIR: "/evil", GIT_CONFIG_GLOBAL: "/dev/null" });
		expect(gitEnv.GIT_DIR).toBeUndefined();
		expect(gitEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
		expect(gitEnv.GIT_OPTIONAL_LOCKS).toBe("0");
		expect(gitEnv.LC_ALL).toBe("C");
	});

	it("captures stdout and reports the exit code", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		const res = await boundedSpawn({
			argv: [sh, "-c", "printf hello; exit 3"],
			cwd: dir,
			env,
			timeoutMs: 5000,
			mode: { kind: "capture", cap: 1024 },
		});
		expect(res.outcome).toBe("exited");
		expect(res.exitCode).toBe(3);
		expect(res.stdout.toString()).toBe("hello");
		expect(res.groupCleanup).toBe("confirmed");
	});

	it("reports spawn_failed for a missing executable", async () => {
		const dir = await mkTemp();
		const res = await boundedSpawn({
			argv: [path.join(dir, "nope")],
			cwd: dir,
			env,
			timeoutMs: 1000,
			mode: { kind: "capture", cap: 16 },
		});
		expect(res.outcome).toBe("spawn_failed");
	});

	it("kills the whole process group on timeout (grandchild included)", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		const script = `sleep 60 & echo $! > "${dir}/child.pid"; echo $$ > "${dir}/self.pid"; wait`;
		const res = await boundedSpawn({
			argv: [sh, "-c", script],
			cwd: dir,
			env,
			timeoutMs: 400,
			mode: { kind: "drain", ceiling: 1024 },
		});
		expect(res.outcome).toBe("timeout");
		expect(res.groupCleanup).toBe("confirmed");
		const child = Number(await waitFile(path.join(dir, "child.pid")));
		const self = Number(await waitFile(path.join(dir, "self.pid")));
		expect(pidAlive(child)).toBe(false);
		expect(pidAlive(self)).toBe(false);
	}, 15_000);

	it("kills a lingering group member after a normal exit", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		const script = `sleep 60 >/dev/null 2>&1 & echo $! > "${dir}/child.pid"; exit 0`;
		const res = await boundedSpawn({
			argv: [sh, "-c", script],
			cwd: dir,
			env,
			timeoutMs: 5000,
			mode: { kind: "drain", ceiling: 1024 },
		});
		expect(res.outcome).toBe("exited");
		expect(res.groupCleanup).toBe("confirmed");
		expect(pidAlive(Number(await waitFile(path.join(dir, "child.pid"))))).toBe(false);
	}, 15_000);

	it("stops at the output ceiling and never returns truncated output as success", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		const res = await boundedSpawn({
			argv: [sh, "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"],
			cwd: dir,
			env,
			timeoutMs: 10_000,
			mode: { kind: "drain", ceiling: 4096 },
		});
		expect(res.outcome).toBe("output_limit");
		expect(res.groupCleanup).toBe("confirmed");
	}, 15_000);

	it("cancels on abort and reaps the group", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 150);
		const res = await boundedSpawn({
			argv: [sh, "-c", "sleep 30"],
			cwd: dir,
			env,
			timeoutMs: 20_000,
			mode: { kind: "drain", ceiling: 1024 },
			signal: ac.signal,
		});
		expect(res.outcome).toBe("cancelled");
		expect(res.groupCleanup).toBe("confirmed");
		await fs.stat(dir);
	}, 15_000);

	it("reports output_incomplete (not exited) when a descendant outside the group keeps the pipe open", async () => {
		const dir = await mkTemp();
		const sh = (await resolveExecutable("sh", env.PATH)) as string;
		// perl setsid()s out of the process group, so the post-exit sweep cannot reach it and the stream never ends.
		const script = `printf partial; perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "${dir}/escaped"); close(F); sleep 3' & while [ ! -e "${dir}/escaped" ]; do sleep 0.02; done; exit 0`;
		const res = await boundedSpawn({
			argv: [sh, "-c", script],
			cwd: dir,
			env,
			timeoutMs: 10_000,
			mode: { kind: "capture", cap: 1024 },
		});
		expect(res.exitCode).toBe(0);
		expect(res.outcome).toBe("output_incomplete");
	}, 15_000);

	it("runGit treats an incomplete capture as a failure instead of complete git output", async () => {
		const dir = await mkTemp();
		const fake = path.join(dir, "git");
		await fs.writeFile(
			fake,
			`#!/bin/sh\nrm -f "${dir}/escaped"\nprintf 'a.ts'; perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "${dir}/escaped"); close(F); sleep 3' &\nwhile [ ! -e "${dir}/escaped" ]; do sleep 0.02; done\nexit 0\n`,
			{ mode: 0o755 },
		);
		const g = await makeGitContext(dir, 10_000, { PATH: process.env.PATH });
		g.gitPath = fake;
		expect(await runGit(g, ["status"], { kind: "capture", cap: 1024 })).toEqual({ ok: false, sub: "git_failed" });
		expect(await runGit(g, ["ls-files"], { kind: "stream", cap: 1024, onChunk: () => {} })).toEqual({
			ok: false,
			sub: "git_failed",
		});
	}, 20_000);
});
