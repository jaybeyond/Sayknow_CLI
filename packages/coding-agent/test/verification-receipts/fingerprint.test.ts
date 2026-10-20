import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasUnsupportedFilter } from "../../bundles/verification-receipts/tools/verification-git";
import {
	fingerprint,
	makeGitContext,
	resolveExecutable,
	runFreshness,
} from "../../bundles/verification-receipts/tools/verification-status";
import { cleanupTemps, git, mkRepo, mkTemp, write } from "./helpers";

afterEach(cleanupTemps);
const ENV = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function fp(repo: string, inputs: string[] = [], limits?: Parameters<typeof fingerprint>[4]) {
	const g = await makeGitContext(repo, 5000, ENV);
	return fingerprint(g, await fs.realpath(repo), inputs, "spec", limits);
}

describe("freshness fingerprint", () => {
	it("is stable when nothing changes and never touches the index", async () => {
		const repo = await mkRepo();
		const before = await fs.stat(path.join(repo, ".git", "index"));
		const a = await fp(repo, ["a.test.ts"]);
		const b = await fp(repo, ["a.test.ts"]);
		const after = await fs.stat(path.join(repo, ".git", "index"));
		expect(a.status).toBe("available");
		expect(a.digest).toBe(b.digest as string);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(a.counts.indexEntries).toBe(2);
	});

	it("changes for tracked edits, untracked files, deletions, new commits and selected inputs", async () => {
		const repo = await mkRepo();
		const seen = new Set<string | null>([(await fp(repo, ["a.test.ts"])).digest]);
		const step = async (change: () => Promise<unknown>) => {
			await change();
			const d = (await fp(repo, ["a.test.ts"])).digest;
			expect(d).not.toBeNull();
			expect(seen.has(d)).toBe(false);
			seen.add(d);
		};
		await step(() => write(repo, "a.ts", "export const a = 2;\n"));
		await step(() => write(repo, "new.ts", "x"));
		await step(() => write(repo, "deep/dir/new2.ts", "y"));
		await step(() => fs.rm(path.join(repo, "a.ts")));
		await step(() => git(repo, "add", "-A"));
		await step(() => git(repo, "commit", "-q", "-m", "c2"));
		await step(() => write(repo, "a.test.ts", "// edited\n"));
	});

	it("sees untracked files even when the repo config hides them", async () => {
		const repo = await mkRepo();
		await git(repo, "config", "status.showUntrackedFiles", "no");
		const a = await fp(repo);
		await write(repo, "dir/hidden.ts", "z");
		const b = await fp(repo);
		expect(b.digest).not.toBe(a.digest as string);
		expect(b.counts.dirtyPaths).toBe(1);
	});

	it("includes assume-unchanged and skip-worktree files", async () => {
		const repo = await mkRepo();
		await git(repo, "update-index", "--assume-unchanged", "a.ts");
		const a = await fp(repo);
		await write(repo, "a.ts", "export const a = 7;\n");
		const b = await fp(repo);
		expect(b.digest).not.toBe(a.digest as string);
		await git(repo, "update-index", "--no-assume-unchanged", "a.ts");
		await git(repo, "update-index", "--skip-worktree", "a.ts");
		await write(repo, "a.ts", "export const a = 8;\n");
		const c = await fp(repo);
		expect(c.digest).not.toBe(b.digest as string);
	});

	it("never yields a digest over a prefix when a limit is hit", async () => {
		const repo = await mkRepo();
		for (const n of ["u1", "u2", "u3"]) await write(repo, `${n}.ts`, n);
		const files = await fp(repo, [], { maxIndexEntries: 200_000, maxDirtyPaths: 2, maxDirtyBytes: 1 << 20 });
		expect(files).toMatchObject({ status: "unavailable", reason: "file_limit", digest: null, sourceDigest: null });
		const bytes = await fp(repo, [], { maxIndexEntries: 200_000, maxDirtyPaths: 100, maxDirtyBytes: 2 });
		expect(bytes).toMatchObject({ status: "unavailable", reason: "byte_limit", digest: null });
		const entries = await fp(repo, [], { maxIndexEntries: 1, maxDirtyPaths: 100, maxDirtyBytes: 1 << 20 });
		expect(entries).toMatchObject({ status: "unavailable", reason: "file_limit" });
	});

	it("rejects symlinked and missing selected inputs", async () => {
		const repo = await mkRepo();
		await fs.symlink(path.join(repo, "a.test.ts"), path.join(repo, "l.test.ts"));
		expect(await fp(repo, ["l.test.ts"])).toMatchObject({ status: "unavailable", reason: "unsafe_selected_input" });
		expect(await fp(repo, ["nope.test.ts"])).toMatchObject({
			status: "unavailable",
			reason: "selected_input_unavailable",
		});
		await fs.mkdir(path.join(repo, "real"));
		await write(repo, "real/x.test.ts", "x");
		await fs.symlink(path.join(repo, "real"), path.join(repo, "alias"));
		expect(await fp(repo, ["alias/x.test.ts"])).toMatchObject({
			status: "unavailable",
			reason: "unsafe_selected_input",
		});
	});

	it("hashes gitignored selected inputs", async () => {
		const repo = await mkRepo();
		await write(repo, ".gitignore", "ign.test.ts\n");
		await write(repo, "ign.test.ts", "one");
		const a = await fp(repo, ["ign.test.ts"]);
		await write(repo, "ign.test.ts", "two");
		const b = await fp(repo, ["ign.test.ts"]);
		expect(a.status).toBe("available");
		expect(b.digest).not.toBe(a.digest as string);
		expect(b.sourceDigest).toBe(a.sourceDigest as string);
	});

	it("an unborn HEAD is observable (head null) and a dirty submodule-free tree still fingerprints", async () => {
		const repo = await mkRepo();
		const empty = (await import("./helpers")).mkTemp;
		const dir = await empty("skc-vr-unborn-");
		await git(dir, "init", "-q", "-b", "main");
		await write(dir, "x.ts", "x");
		const f = await fp(dir);
		expect(f).toMatchObject({ status: "available", head: null });
		expect((await fp(repo)).head).toMatch(/^[0-9a-f]{40}$/);
	});

	it("runFreshness maps before/after pairs", async () => {
		const repo = await mkRepo();
		const a = await fp(repo);
		await write(repo, "n.ts", "n");
		const b = await fp(repo);
		expect(runFreshness(a, a)).toBe("fresh");
		expect(runFreshness(a, b)).toBe("changed_during_run");
		expect(runFreshness({ ...a, status: "unavailable" }, b)).toBe("unavailable");
	});
});

/**
 * A git wrapper: `body` may intercept argv (`$sub` is the subcommand, `$arg` its first argument; the leading
 * `--no-optional-locks -c core.*=...` pins are skipped) and otherwise falls through to real git.
 */
async function fakeGit(repo: string, body: string, timeoutMs = 5000) {
	const real = (await resolveExecutable("git", ENV.PATH)) as string;
	const script = path.join(await mkTemp("skc-vr-fakegit-"), "git");
	const prelude = `sub=; arg=\nfor a in "$@"; do\n  if [ -n "$sub" ]; then arg="$a"; break; fi\n  case "$a" in --no-optional-locks|-c|core.*) ;; *) sub="$a";; esac\ndone`;
	await fs.writeFile(script, `#!/bin/sh\n${prelude}\n${body}\nexec "${real}" "$@"\n`, { mode: 0o755 });
	const g = await makeGitContext(repo, timeoutMs, ENV);
	g.gitPath = script;
	return g;
}
describe("freshness fingerprint: every unavailable reason carries no digest", () => {
	const none = { digest: null, sourceDigest: null, selectedDigest: null };

	const fpWith = async (g: Awaited<ReturnType<typeof makeGitContext>>, repo: string) =>
		fingerprint(g, await fs.realpath(repo), [], "spec");

	it("source_unreadable: EACCES on a non-searchable parent of a dirty path is never hashed as deleted", async () => {
		const repo = await mkRepo();
		await write(repo, "d/e/x.ts", "one");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "nested");
		await git(repo, "update-index", "--assume-unchanged", "d/e/x.ts");
		const dir = path.join(repo, "d");
		await fs.chmod(dir, 0o000);
		try {
			expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "source_unreadable", ...none });
		} finally {
			await fs.chmod(dir, 0o755);
		}
		// A readable parent with a genuinely deleted file is still a legitimate `deleted` entry.
		await fs.rm(path.join(repo, "d", "e", "x.ts"));
		expect((await fp(repo)).status).toBe("available");
	});

	it("source_unreadable: EACCES on the dirty file's own directory entry (leaf parent) is unavailable", async () => {
		const repo = await mkRepo();
		await write(repo, "d/x.ts", "one");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "nested");
		await git(repo, "update-index", "--assume-unchanged", "d/x.ts");
		await fs.chmod(path.join(repo, "d"), 0o000);
		try {
			expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "source_unreadable", ...none });
		} finally {
			await fs.chmod(path.join(repo, "d"), 0o755);
		}
	});

	it("symlink_parent: a dirty path below a symlinked directory", async () => {
		const repo = await mkRepo();
		await write(repo, "real/x.ts", "x");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "real");
		const elsewhere = await mkTemp("skc-vr-else-");
		await write(elsewhere, "x.ts", "other");
		await fs.rm(path.join(repo, "real"), { recursive: true });
		await fs.symlink(elsewhere, path.join(repo, "real"));
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "symlink_parent", ...none });
	});

	it("unsupported_file: an untracked nested repository directory", async () => {
		const repo = await mkRepo();
		await fs.mkdir(path.join(repo, "nested"));
		await git(path.join(repo, "nested"), "init", "-q", "-b", "main");
		await write(repo, "nested/f.ts", "f");
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "unsupported_file", ...none });
	});

	it("submodule_dirty: a dirty gitlink entry", async () => {
		const repo = await mkRepo();
		const head = (await git(repo, "rev-parse", "HEAD")).trim();
		await git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "submodule_dirty", ...none });
	});

	it("changed_while_hashing: a dirty file that keeps changing while it is read", async () => {
		const repo = await mkRepo();
		const big = path.join(repo, "big.bin");
		await fs.writeFile(big, Buffer.alloc(48 * 1024 * 1024, 1));
		let stop = false;
		const writer = (async () => {
			const handle = await fs.open(big, "a");
			while (!stop) {
				await handle.write("x");
				await Bun.sleep(0);
			}
			await handle.close();
		})();
		try {
			expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "changed_while_hashing", ...none });
		} finally {
			stop = true;
			await writer;
		}
	});

	it("invalid_index: a malformed `ls-files --stage` record and a truncated `ls-files -v` stream", async () => {
		const repo = await mkRepo();
		const garbage = await fakeGit(
			repo,
			`[ "$sub" = ls-files ] && [ "$arg" = --stage ] && { printf 'garbage\\000'; exit 0; }`,
		);
		expect(await fpWith(garbage, repo)).toMatchObject({ status: "unavailable", reason: "invalid_index", ...none });
		const cutOff = await fakeGit(repo, `[ "$sub" = ls-files ] && [ "$arg" = -v ] && { printf 'H a.ts'; exit 0; }`);
		expect(await fpWith(cutOff, repo)).toMatchObject({ status: "unavailable", reason: "invalid_index", ...none });
	});

	it("unsafe_root: the toplevel is a symlink", async () => {
		const repo = await mkRepo();
		const holder = await mkTemp("skc-vr-root-");
		const link = path.join(holder, "link");
		await fs.symlink(repo, link);
		const g = await makeGitContext(repo, 5000, ENV);
		expect(await fingerprint(g, link, [], "spec")).toMatchObject({
			status: "unavailable",
			reason: "unsafe_root",
			...none,
		});
	});

	it("git_unavailable: no git executable, a failing git and a git that exits with partial output", async () => {
		const repo = await mkRepo();
		const missing = await makeGitContext(repo, 5000, ENV);
		missing.gitPath = null;
		expect(await fpWith(missing, repo)).toMatchObject({
			status: "unavailable",
			reason: "git_unavailable",
			subreason: "spawn_failed",
			...none,
		});
		const failing = await fakeGit(repo, `[ "$sub" = status ] && exit 3`);
		expect(await fpWith(failing, repo)).toMatchObject({
			status: "unavailable",
			reason: "git_unavailable",
			subreason: "git_failed",
			...none,
		});
	});
});

describe("freshness fingerprint: AC9 rows and repository-config hardening", () => {
	it("git_timeout: a git that outlives its budget is unavailable/git_timeout with no digest", async () => {
		const repo = await mkRepo();
		const slow = await fakeGit(repo, `[ "$sub" = status ] && sleep 5`, 200);
		const started = Date.now();
		expect(await fingerprint(slow, await fs.realpath(repo), [], "spec")).toMatchObject({
			status: "unavailable",
			reason: "git_unavailable",
			subreason: "git_timeout",
			digest: null,
			sourceDigest: null,
		});
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it("staging an already-dirty file (credentials) changes the digest although the bytes did not change", async () => {
		const repo = await mkRepo();
		await write(repo, ".env", "TOKEN=1\n");
		const before = await fp(repo);
		await git(repo, "add", ".env");
		const after = await fp(repo);
		expect(after.digest).not.toBe(before.digest as string);
		expect(after.counts.dirtyPaths).toBe(before.counts.dirtyPaths);
	});

	it("an untracked `.skc/x` keeps the digest, while an edit of a tracked `.skc` file changes it", async () => {
		const repo = await mkRepo();
		await write(repo, ".skc/tracked.md", "one\n");
		await git(repo, "add", "-f", ".skc/tracked.md");
		await git(repo, "commit", "-q", "-m", "skc");
		const base = await fp(repo);
		await write(repo, ".skc/x", "scratch\n");
		await write(repo, "deep/.skc/y/z", "scratch\n");
		const withUntracked = await fp(repo);
		expect(withUntracked.digest).toBe(base.digest as string);
		expect(withUntracked.counts.dirtyPaths).toBe(0);
		await write(repo, ".skc/tracked.md", "two\n");
		const edited = await fp(repo);
		expect(edited.digest).not.toBe(base.digest as string);
		expect(edited.counts.dirtyPaths).toBe(1);
	});

	it("an untracked directory with two files counts both paths as dirty", async () => {
		const repo = await mkRepo();
		await write(repo, "newdir/one.ts", "1");
		await write(repo, "newdir/two.ts", "2");
		const f = await fp(repo);
		expect(f.counts.dirtyPaths).toBe(2);
	});

	it("diff.ignoreSubmodules=all / submodule.<name>.ignore=all cannot hide a dirty submodule", async () => {
		const repo = await mkRepo();
		const upstream = await mkTemp("skc-vr-subsrc-");
		await git(upstream, "init", "-q", "-b", "main");
		await write(upstream, "lib.ts", "export const lib = 1;\n");
		await git(upstream, "add", "-A");
		await git(upstream, "commit", "-q", "-m", "lib");
		await git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
		await git(repo, "commit", "-q", "-m", "add submodule");
		await git(repo, "config", "diff.ignoreSubmodules", "all");
		await git(repo, "config", "status.submoduleSummary", "false");
		await git(repo, "config", "submodule.sub.ignore", "all");
		await write(repo, "sub/lib.ts", "export const lib = 2;\n");
		// the repo config really does hide the dirty submodule from a plain `git status`
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "submodule_dirty", digest: null });
	});

	it("BLK-5: every git call pins the stat/refresh config knobs", async () => {
		const repo = await mkRepo();
		const log = path.join(await mkTemp("skc-vr-gitlog-"), "argv.log");
		const spy = await fakeGit(repo, `printf '%s\\n' "$*" >> "${log}"`);
		const f = await fingerprint(spy, await fs.realpath(repo), ["a.test.ts"], "spec");
		expect(f.status).toBe("available");
		const lines = (await fs.readFile(log, "utf8")).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(4);
		for (const line of lines) {
			for (const pin of [
				"core.fsmonitor=false",
				"core.trustctime=true",
				"core.checkStat=default",
				"core.ignoreStat=false",
				"core.untrackedCache=false",
				"core.fileMode=true",
				"core.symlinks=true",
				"core.ignorecase=false",
			])
				expect(line).toContain(`-c ${pin}`);
		}
	});

	it("BLK-5: repo-local core.trustctime=false cannot hide a same-size rewrite with the mtime restored", async () => {
		const repo = await mkRepo();
		const target = path.join(repo, "a.ts");
		const past = new Date(Date.now() - 60_000);
		await fs.utimes(target, past, past);
		await git(repo, "config", "core.trustctime", "false");
		await git(repo, "update-index", "--refresh");
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100); // git compares ctime at second granularity
		await fs.writeFile(target, "export const a = 2;\n"); // same size as "export const a = 1;\n"
		await fs.utimes(target, past, past);
		// proof the attack works against an unpinned git: plain status sees nothing
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		const after = await fp(repo, ["a.test.ts"]);
		expect(after.counts.dirtyPaths).toBe(1);
		expect(after.digest).not.toBe(before.digest as string);
	});

	it("BLK-5: core.checkStat=minimal plus an inode-replacing rewrite cannot hide the edit either", async () => {
		const repo = await mkRepo();
		const target = path.join(repo, "a.ts");
		const past = new Date(Date.now() - 60_000);
		await fs.utimes(target, past, past);
		await git(repo, "config", "core.trustctime", "false");
		await git(repo, "config", "core.checkStat", "minimal");
		await git(repo, "update-index", "--refresh");
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100); // git compares ctime at second granularity
		await write(repo, "a.ts.tmp", "export const a = 3;\n");
		await fs.utimes(path.join(repo, "a.ts.tmp"), past, past);
		await fs.rename(path.join(repo, "a.ts.tmp"), target);
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		const after = await fp(repo, ["a.test.ts"]);
		expect(after.digest).not.toBe(before.digest as string);
	});

	it("BLK-2: sourceFingerprint runs git at the toplevel even when handed a subdirectory context", async () => {
		const repo = await mkRepo();
		await write(repo, "pkg/p.ts", "export const p = 1;\n");
		await write(repo, "lib/l.ts", "export const l = 1;\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "layout");
		await git(repo, "update-index", "--skip-worktree", "lib/l.ts");
		const top = await fs.realpath(repo);
		const atTop = await fingerprint(await makeGitContext(top, 5000, ENV), top, [], "spec");
		const atSub = await fingerprint(await makeGitContext(path.join(top, "pkg"), 5000, ENV), top, [], "spec");
		expect(atSub).toEqual(atTop);
		expect(atSub.counts).toMatchObject({ indexEntries: 4, dirtyPaths: 1 });
	});

	it("BLK-6: a mode-only change of a dirty file (tracked or untracked) changes the digest", async () => {
		const repo = await mkRepo();
		await write(repo, "a.ts", "export const a = 4;\n"); // tracked and dirty
		await write(repo, "helper.sh", "#!/bin/sh\n"); // untracked
		await fs.chmod(path.join(repo, "helper.sh"), 0o755);
		const before = await fp(repo);
		await fs.chmod(path.join(repo, "helper.sh"), 0o644);
		const untracked = await fp(repo);
		expect(untracked.digest).not.toBe(before.digest as string);
		await fs.chmod(path.join(repo, "a.ts"), 0o755);
		const tracked = await fp(repo);
		expect(tracked.digest).not.toBe(untracked.digest as string);
		await fs.chmod(path.join(repo, "a.ts"), 0o644);
		expect((await fp(repo)).digest).toBe(untracked.digest as string);
	});
	it("R3-4: repo-local core.fileMode=false cannot hide a chmod of a clean tracked file", async () => {
		const repo = await mkRepo();
		await write(repo, "tool.sh", "#!/bin/sh\n");
		await fs.chmod(path.join(repo, "tool.sh"), 0o755);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "tool");
		await git(repo, "config", "core.fileMode", "false");
		const before = await fp(repo, ["a.test.ts"]);
		await fs.chmod(path.join(repo, "tool.sh"), 0o644);
		// the unpinned repo config really hides the change from plain git
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		const after = await fp(repo, ["a.test.ts"]);
		expect(after.status).toBe("available");
		expect(after.counts.dirtyPaths).toBe(1);
		expect(after.digest).not.toBe(before.digest as string);
		await fs.chmod(path.join(repo, "tool.sh"), 0o755);
		expect((await fp(repo, ["a.test.ts"])).digest).toBe(before.digest as string);
	});
});

describe("R3-5: repo-local clean filters fail closed", () => {
	const filtered = async () => {
		const repo = await mkRepo();
		await fs.writeFile(path.join(repo, ".git", "info", "attributes"), "a.ts filter=pin\n");
		await git(repo, "config", "filter.pin.clean", "git show HEAD:a.ts");
		return repo;
	};
	it("QA repro: the filter really hides the edit from git, yet the fingerprint is unavailable/unsupported_config", async () => {
		const repo = await filtered();
		await write(repo, "a.ts", "export const a = 2;\n");
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		expect(await fp(repo, ["a.test.ts"])).toMatchObject({
			status: "unavailable",
			reason: "unsupported_config",
			digest: null,
			sourceDigest: null,
		});
	});
	it("a filter in an included config file or the worktree config file is just as unsupported", async () => {
		const repo = await mkRepo();
		const extra = path.join(await mkTemp("skc-vr-inc-"), "extra.cfg");
		await fs.writeFile(extra, '[filter "x"]\n\tclean = cat\n');
		await git(repo, "config", "include.path", extra);
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "unsupported_config" });
		const repo2 = await mkRepo();
		await git(repo2, "config", "extensions.worktreeConfig", "true");
		await git(repo2, "config", "--worktree", "filter.w.process", "cat");
		expect(await fp(repo2)).toMatchObject({ status: "unavailable", reason: "unsupported_config" });
	});
	it("a filter driver defined only in global config (a user's own git-lfs) is not examined", async () => {
		const repo = await mkRepo();
		const globalCfg = path.join(await mkTemp("skc-vr-glob-"), "gitconfig");
		await fs.writeFile(
			globalCfg,
			'[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tprocess = git-lfs filter-process\n[filter "mine"]\n\tclean = cat\n',
		);
		const g = await makeGitContext(repo, 5000, { ...ENV, GIT_CONFIG_GLOBAL: globalCfg });
		const f = await fingerprint(g, await fs.realpath(repo), ["a.test.ts"], "spec");
		expect(f.status).toBe("available");
	});
	it("the stock git-lfs drivers in repo-local config are allowed; any other command named lfs is not", async () => {
		const repo = await mkRepo();
		await git(repo, "config", "filter.lfs.clean", "git-lfs clean -- %f");
		await git(repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
		await git(repo, "config", "filter.lfs.process", "git-lfs filter-process");
		expect((await fp(repo)).status).toBe("available");
		await git(repo, "config", "filter.lfs.clean", "git show HEAD:a.ts");
		expect(await fp(repo)).toMatchObject({ status: "unavailable", reason: "unsupported_config" });
	});
	it("hasUnsupportedFilter: scopes, stock drivers and malformed output", () => {
		const rec = (scope: string, key: string, value: string) => `${scope}\0${key}\n${value}\0`;
		expect(hasUnsupportedFilter("")).toBe(false);
		expect(
			hasUnsupportedFilter(rec("global", "filter.x.clean", "cat") + rec("system", "filter.y.process", "p")),
		).toBe(false);
		expect(hasUnsupportedFilter(rec("local", "filter.lfs.clean", "git-lfs clean %f"))).toBe(false);
		expect(hasUnsupportedFilter(rec("local", "filter.LFS.clean", "git-lfs clean -- %f"))).toBe(true);
		expect(hasUnsupportedFilter(rec("local", "filter.lfs.process", "git-lfs filter-process --skip"))).toBe(false);
		expect(hasUnsupportedFilter(rec("worktree", "filter.a.b.clean", "x"))).toBe(true);
		expect(hasUnsupportedFilter(rec("command", "filter.lfs.clean", "git-lfs clean -- %f; evil"))).toBe(true);
		expect(hasUnsupportedFilter("local\0filter.x.clean")).toBe(true); // truncated
		expect(hasUnsupportedFilter("garbage")).toBe(true);
	});
});

describe("R4-2: core.symlinks is pinned", () => {
	it("repo-local core.symlinks=false cannot hide a symlink -> regular file swap", async () => {
		const repo = await mkRepo();
		await fs.symlink("a.ts", path.join(repo, "l.ts"));
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "link");
		await git(repo, "config", "core.symlinks", "false");
		const before = await fp(repo, ["a.test.ts"]);
		await fs.rm(path.join(repo, "l.ts"));
		await fs.writeFile(path.join(repo, "l.ts"), "a.ts"); // a regular file holding the link target
		// the unpinned repo config really hides the swap from plain git
		expect((await git(repo, "status", "--porcelain")).trim()).toBe("");
		const after = await fp(repo, ["a.test.ts"]);
		expect(after.status).toBe("available");
		expect(after.digest).not.toBe(before.digest as string);
	});
});

/** True when `os.tmpdir()` (where `mkRepo` creates repositories) distinguishes `a` from `A`. */
function tmpdirIsCaseSensitive(): boolean {
	const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "skc-vr-case-"));
	try {
		fsSync.writeFileSync(path.join(probe, "a"), "");
		return !fsSync.existsSync(path.join(probe, "A"));
	} finally {
		fsSync.rmSync(probe, { recursive: true, force: true });
	}
}

describe("core.ignorecase is pinned", () => {
	it.skipIf(!tmpdirIsCaseSensitive())(
		"repo-local core.ignorecase=true cannot hide an untracked file differing only in case (case-sensitive fs)",
		async () => {
			const repo = await mkRepo();
			await git(repo, "config", "core.ignorecase", "true");
			const before = await fp(repo, ["a.test.ts"]);
			await write(repo, "A.ts", "export const a = 2;\n");
			// the unpinned repo config really hides the new file from plain git
			expect((await git(repo, "status", "--porcelain", "--untracked-files=all")).trim()).toBe("");
			const after = await fp(repo, ["a.test.ts"]);
			expect(after.status).toBe("available");
			expect(after.digest).not.toBe(before.digest as string);
		},
	);
});

describe("R4-3: check-in conversions cannot hide a same-size edit", () => {
	const commitWith = async (attributes: string, rel: string, content: string | Buffer) => {
		const repo = await mkRepo();
		await write(repo, ".gitattributes", attributes);
		await fs.writeFile(path.join(repo, rel), content);
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "convert");
		await Bun.sleep(1100); // git compares stat data at second granularity; an edit must not share the index second
		return repo;
	};
	const expectHiddenFromStatus = async (repo: string) =>
		expect((await git(repo, "--no-optional-locks", "status", "--porcelain")).trim()).toBe("");

	it("eol: a CRLF move inside a `text=auto eol=lf` file changes the digest", async () => {
		const repo = await commitWith("* text=auto eol=lf\n", "data.txt", "a\r\nb\n");
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100);
		await fs.writeFile(path.join(repo, "data.txt"), "a\nb\r\n"); // same size, same converted content
		await expectHiddenFromStatus(repo);
		const after = await fp(repo, ["a.test.ts"]);
		expect(after.counts.dirtyPaths).toBe(1);
		expect(after.digest).not.toBe(before.digest as string);
	});
	it("ident: an edit inside an expanded `$Id: ... $` changes the digest", async () => {
		const repo = await mkRepo();
		await write(repo, "i.ts", 'export const i = "$Id$";\n');
		await write(repo, ".gitattributes", "i.ts ident\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "ident");
		await fs.rm(path.join(repo, "i.ts"));
		await git(repo, "checkout", "--", "i.ts"); // expands $Id$ to $Id: <blob> $
		await Bun.sleep(1100);
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100);
		const text = await fs.readFile(path.join(repo, "i.ts"), "utf8");
		expect(text).toMatch(/\$Id: [0-9a-f]{40} \$/);
		await fs.writeFile(path.join(repo, "i.ts"), text.replace(/\$Id: [0-9a-f]{40}/, `$Id: ${"0".repeat(40)}`));
		await expectHiddenFromStatus(repo);
		expect((await fp(repo, ["a.test.ts"])).digest).not.toBe(before.digest as string);
	});
	it("working-tree-encoding: a UTF-16 BOM flip changes the digest", async () => {
		const repo = await commitWith(
			"*.u16 working-tree-encoding=UTF-16\n",
			"x.u16",
			Buffer.from("fffe68006900", "hex"),
		);
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100);
		await fs.writeFile(path.join(repo, "x.u16"), Buffer.from("feff00680069", "hex")); // big-endian, same text
		await expectHiddenFromStatus(repo);
		expect((await fp(repo, ["a.test.ts"])).digest).not.toBe(before.digest as string);
	});
	it("core.attributesFile and core.autocrlf (repo-local config) are covered the same way", async () => {
		const repo = await mkRepo();
		const attrs = path.join(await mkTemp("skc-vr-attr-"), "attributes");
		await fs.writeFile(attrs, "*.txt text eol=lf\n");
		await git(repo, "config", "core.attributesFile", attrs);
		await fs.writeFile(path.join(repo, "d.txt"), "a\r\nb\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "txt");
		await Bun.sleep(1100);
		const before = await fp(repo, ["a.test.ts"]);
		await Bun.sleep(1100);
		await fs.writeFile(path.join(repo, "d.txt"), "a\nb\r\n");
		await expectHiddenFromStatus(repo);
		expect((await fp(repo, ["a.test.ts"])).digest).not.toBe(before.digest as string);
	});

	it("two back-to-back fingerprints of an unchanged repository are equal, also right after a commit and with conversions", async () => {
		const plain = await mkRepo(); // committed this very second: racily clean entries
		const a = await fp(plain, ["a.test.ts"]);
		const b = await fp(plain, ["a.test.ts"]);
		expect(a.status).toBe("available");
		expect(b.digest).toBe(a.digest as string);
		expect(a.counts.dirtyPaths).toBe(0);
		const converted = await commitWith("* text=auto eol=lf\n", "data.txt", "a\r\nb\n");
		const c = await fp(converted, ["a.test.ts"]);
		expect((await fp(converted, ["a.test.ts"])).digest).toBe(c.digest as string);
		expect(c.counts.dirtyPaths).toBe(0);
	});
	it("stat-dirty paths without a content change are listed deterministically and never rewrite .git/index", async () => {
		const repo = await mkRepo();
		await Bun.sleep(1100);
		const future = new Date(Date.now() + 5000);
		await fs.utimes(path.join(repo, "a.ts"), future, future); // stat changes, content does not: plain status is clean
		await expectHiddenFromStatus(repo);
		const index = path.join(repo, ".git", "index");
		const before = await fs.stat(index);
		const a = await fp(repo, ["a.test.ts"]);
		const b = await fp(repo, ["a.test.ts"]);
		const after = await fs.stat(index);
		expect(a.counts.dirtyPaths).toBe(1);
		expect(b.digest).toBe(a.digest as string);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.size).toBe(before.size);
	});
	it("the union respects the dirty-path limit and a failing diff-files is unavailable, never a digest", async () => {
		const repo = await mkRepo();
		await Bun.sleep(1100);
		const future = new Date(Date.now() + 5000);
		await fs.utimes(path.join(repo, "a.ts"), future, future);
		expect(await fp(repo, [], { maxIndexEntries: 100, maxDirtyPaths: 0, maxDirtyBytes: 1024 })).toMatchObject({
			status: "unavailable",
			reason: "file_limit",
			digest: null,
		});
		const failing = await fakeGit(repo, `[ "$sub" = diff-files ] && exit 3`);
		expect(await fingerprint(failing, await fs.realpath(repo), [], "spec")).toMatchObject({
			status: "unavailable",
			reason: "git_unavailable",
			subreason: "git_failed",
			digest: null,
		});
	});
});
