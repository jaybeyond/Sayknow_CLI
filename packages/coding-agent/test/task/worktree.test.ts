import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@sayknow-cli/natives";
import * as utils from "@sayknow-cli/utils";
import { hashPath } from "@sayknow-cli/utils";
import {
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	ensureIsolation,
	getGitNoIndexNullPath,
	getRepoRoot,
	mergeTaskBranches,
	parseIsolationMode,
} from "../../src/task/worktree";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

async function createGitRepo(): Promise<{ baseBranch: string; repo: string }> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "skc-worktree-"));
	tempDirs.push(repo);
	await runGit(repo, ["init"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "merged.txt"), "base version\n");
	await fs.writeFile(path.join(repo, "staged.txt"), "base staged\n");
	await runGit(repo, ["add", "."]);
	await runGit(repo, ["commit", "-m", "initial"]);
	return {
		baseBranch: await runGit(repo, ["branch", "--show-current"]),
		repo,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("worktree isolation helpers", () => {
	it("returns platform-specific null path for git --no-index diffs", () => {
		const expected = process.platform === "win32" ? "NUL" : "/dev/null";
		expect(getGitNoIndexNullPath()).toBe(expected);
	});

	it("maps every isolation mode to the native backend contract", () => {
		expect(parseIsolationMode("none")).toBeUndefined();
		expect(parseIsolationMode("auto")).toBeUndefined();
		expect(parseIsolationMode("apfs")).toBe(natives.IsoBackendKind.Apfs);
		expect(parseIsolationMode("btrfs")).toBe(natives.IsoBackendKind.Btrfs);
		expect(parseIsolationMode("zfs")).toBe(natives.IsoBackendKind.Zfs);
		expect(parseIsolationMode("reflink")).toBe(natives.IsoBackendKind.LinuxReflink);
		expect(parseIsolationMode("overlayfs")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("fuse-overlay")).toBe(natives.IsoBackendKind.Overlayfs);
		expect(parseIsolationMode("projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("fuse-projfs")).toBe(natives.IsoBackendKind.Projfs);
		expect(parseIsolationMode("block-clone")).toBe(natives.IsoBackendKind.WindowsBlockClone);
		expect(parseIsolationMode("rcopy")).toBe(natives.IsoBackendKind.Rcopy);
		expect(parseIsolationMode("worktree")).toBe(natives.IsoBackendKind.Rcopy);
	});

	it("retries isoResolve candidates when a backend is path-unavailable", async () => {
		const { repo } = await createGitRepo();
		const wt = await fs.mkdtemp(path.join(os.tmpdir(), "skc-iso-wt-"));
		tempDirs.push(wt);
		vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
		vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
		const unavailable = new Error("ISO_UNAVAILABLE: btrfs source is not a subvolume");
		const isoResolve = vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Btrfs,
			candidates: [natives.IsoBackendKind.Btrfs, natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		const isoStart = vi
			.spyOn(natives, "isoStart")
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce(undefined);
		vi.spyOn(natives, "isoIsUnavailableError").mockImplementation(message => message.startsWith("ISO_UNAVAILABLE:"));

		const handle = await ensureIsolation(repo, "retry-path-unavailable");

		expect(isoResolve).toHaveBeenCalledWith(null);
		expect(isoStart.mock.calls.map(call => call[0])).toEqual([
			natives.IsoBackendKind.Btrfs,
			natives.IsoBackendKind.Rcopy,
		]);
		expect(handle.backend).toBe(natives.IsoBackendKind.Rcopy);
		expect(handle.fellBack).toBe(true);
		expect(handle.fallbackReason).toBe(unavailable.message);
	});

	it("keeps another session's live isolation tree when the same task id is reused", async () => {
		const { repo } = await createGitRepo();
		const repoRoot = await getRepoRoot(repo);
		const id = "0-T1";
		const wt = await fs.mkdtemp(path.join(os.tmpdir(), "skc-iso-wt-"));
		tempDirs.push(wt);
		vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
		vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
		const canonical = path.join(wt, `${id}-${hashPath(repoRoot)}`);
		const planted = path.join(canonical, "merged", "in-flight-work.ts");
		const created = new Set<string>([canonical]);
		await fs.mkdir(path.dirname(planted), { recursive: true });
		await fs.writeFile(planted, "session A in-flight work\n");
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoIsUnavailableError").mockReturnValue(false);
		const isoStop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
		vi.spyOn(natives, "isoStart").mockImplementation(async (_kind, _lower, merged) => {
			const mergedDir = String(merged);
			await fs.mkdir(mergedDir, { recursive: true });
			await fs.writeFile(path.join(mergedDir, "in-flight-work.ts"), "live\n");
		});

		try {
			const handleA = await ensureIsolation(repo, id);
			const handleB = await ensureIsolation(repo, id);
			created.add(path.dirname(handleA.mergedDir));
			created.add(path.dirname(handleB.mergedDir));

			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			expect(await fs.readFile(path.join(handleA.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			expect(await fs.readFile(path.join(handleB.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			expect(path.dirname(handleA.mergedDir)).not.toBe(canonical);
			expect(path.dirname(handleB.mergedDir)).not.toBe(canonical);
			expect(handleA.mergedDir).not.toBe(handleB.mergedDir);

			await cleanupIsolation(handleB);
			expect(isoStop).toHaveBeenCalledWith(natives.IsoBackendKind.Rcopy, handleB.mergedDir);
			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			expect(await fs.readFile(path.join(handleA.mergedDir, "in-flight-work.ts"), "utf8")).toBe("live\n");
			await expect(fs.stat(handleB.mergedDir)).rejects.toMatchObject({ code: "ENOENT" });

			await cleanupIsolation(handleA);
			expect(await fs.readFile(planted, "utf8")).toBe("session A in-flight work\n");
			await expect(fs.stat(handleA.mergedDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await Promise.all([...created].map(dir => fs.rm(dir, { recursive: true, force: true })));
		}
	});

	it.skipIf(process.platform === "win32")(
		"does not stop or remove an isolation tree that is already a symlink (win32 symlink creation is privileged)",
		async () => {
			const { repo } = await createGitRepo();
			const wt = await fs.mkdtemp(path.join(os.tmpdir(), "skc-iso-wt-"));
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skc-iso-outside-"));
			tempDirs.push(wt, outside);
			vi.spyOn(utils, "getWorktreesDir").mockReturnValue(wt);
			vi.spyOn(utils, "getWorktreeDir").mockImplementation(segment => path.join(wt, segment));
			vi.spyOn(natives, "isoResolve").mockReturnValue({
				kind: natives.IsoBackendKind.Rcopy,
				candidates: [natives.IsoBackendKind.Rcopy],
				fellBack: false,
				reason: undefined,
			});
			vi.spyOn(natives, "isoIsUnavailableError").mockReturnValue(false);
			const isoStop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);
			vi.spyOn(natives, "isoStart").mockImplementation(async (_kind, _lower, merged) => {
				await fs.mkdir(String(merged), { recursive: true });
			});

			const parentHandle = await ensureIsolation(repo, "0-T1");
			const parentBase = path.dirname(parentHandle.mergedDir);
			const outsideMerged = path.join(outside, "merged");
			await fs.mkdir(outsideMerged, { recursive: true });
			await fs.writeFile(path.join(outsideMerged, "secret.txt"), "keep\n");
			await fs.rm(parentBase, { recursive: true, force: true });
			await fs.symlink(outside, parentBase);
			await expect(cleanupIsolation(parentHandle)).rejects.toThrow(/symlinked isolation directory/);
			expect(isoStop).not.toHaveBeenCalled();
			expect(await fs.readFile(path.join(outsideMerged, "secret.txt"), "utf8")).toBe("keep\n");

			const mergedHandle = await ensureIsolation(repo, "0-T2");
			const mergedTarget = await fs.mkdtemp(path.join(os.tmpdir(), "skc-iso-merged-"));
			tempDirs.push(mergedTarget);
			await fs.writeFile(path.join(mergedTarget, "secret.txt"), "keep\n");
			await fs.rm(mergedHandle.mergedDir, { recursive: true, force: true });
			await fs.symlink(mergedTarget, mergedHandle.mergedDir);
			await expect(cleanupIsolation(mergedHandle)).rejects.toThrow(/symlinked isolation merged directory/);
			expect(isoStop).not.toHaveBeenCalled();
			expect(await fs.readFile(path.join(mergedTarget, "secret.txt"), "utf8")).toBe("keep\n");
			expect((await fs.lstat(path.dirname(mergedHandle.mergedDir))).isSymbolicLink()).toBe(false);
		},
	);

	it("does not pop an unrelated pre-existing stash when the working tree is clean", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "preexisting.txt"), "user stash\n");
		await runGit(repo, ["stash", "push", "--include-untracked", "-m", "preexisting-user-stash"]);
		const before = await runGit(repo, ["stash", "list"]);

		const result = await mergeTaskBranches(repo, []);

		expect(result).toEqual({ failed: [], merged: [] });
		expect(await runGit(repo, ["stash", "list"])).toBe(before);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("");
	});

	it("restores staged changes with index preservation after merging task branches", async () => {
		const { baseBranch, repo } = await createGitRepo();
		const taskBranch = "task/merge-staged";
		await runGit(repo, ["checkout", "-b", taskBranch]);
		await fs.writeFile(path.join(repo, "merged.txt"), "task branch change\n");
		await runGit(repo, ["add", "merged.txt"]);
		await runGit(repo, ["commit", "-m", "task-change"]);
		await runGit(repo, ["checkout", baseBranch]);
		await fs.writeFile(path.join(repo, "staged.txt"), "local staged change\n");
		await runGit(repo, ["add", "staged.txt"]);
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");

		const result = await mergeTaskBranches(repo, [{ branchName: taskBranch, taskId: "task-1" }]);

		expect(result).toEqual({ failed: [], merged: [taskBranch] });
		expect(await fs.readFile(path.join(repo, "merged.txt"), "utf8")).toBe("task branch change\n");
		expect(await runGit(repo, ["status", "--porcelain=v1"])).toBe("M  staged.txt");
		expect(await runGit(repo, ["diff", "--cached", "--", "staged.txt"])).toContain("+local staged change");
		expect(await runGit(repo, ["stash", "list"])).toBe("");
	});

	it("subtracts baseline dirty state even when the task commits it", async () => {
		const { repo } = await createGitRepo();
		await fs.writeFile(path.join(repo, "merged.txt"), "baseline dirty change\n");
		await fs.writeFile(path.join(repo, "preexisting.txt"), "baseline untracked\n");
		const baseline = await captureBaseline(repo);

		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-m", "baseline committed inside isolation"]);
		await fs.writeFile(path.join(repo, "task.txt"), "task output\n");
		await runGit(repo, ["add", "task.txt"]);
		await runGit(repo, ["commit", "-m", "task output"]);

		const delta = await captureDeltaPatch(repo, baseline);

		expect(delta.nestedPatches).toEqual([]);
		expect(delta.rootPatch).toContain("task.txt");
		expect(delta.rootPatch).toContain("+task output");
		expect(delta.rootPatch).not.toContain("baseline dirty change");
		expect(delta.rootPatch).not.toContain("preexisting.txt");
	});
});
