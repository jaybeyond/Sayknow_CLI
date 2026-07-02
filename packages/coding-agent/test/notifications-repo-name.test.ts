import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readGitRepoName } from "../src/notifications/index";

const tmpRoots: string[] = [];

function mkdtemp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-reponame-"));
	tmpRoots.push(dir);
	return dir;
}

afterAll(() => {
	for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

test("readGitRepoName returns the repo dir for a normal checkout", () => {
	const root = mkdtemp();
	const repo = path.join(root, "sayknow-cli");
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	expect(readGitRepoName(repo)).toBe("sayknow-cli");
});

test("readGitRepoName resolves the main repo for a linked worktree (not the worktree dir)", () => {
	const root = mkdtemp();
	const repo = path.join(root, "sayknow-cli");
	const mainGit = path.join(repo, ".git");
	const wtGit = path.join(mainGit, "worktrees", "feat-foo-01047f11");
	fs.mkdirSync(wtGit, { recursive: true });
	// The shared `.git` is two levels up from the per-worktree git dir.
	fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");

	const worktree = path.join(root, "worktrees", "feat-foo-01047f11");
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${wtGit}\n`);

	expect(path.basename(worktree)).toBe("feat-foo-01047f11");
	expect(readGitRepoName(worktree)).toBe("sayknow-cli");
});

test("readGitRepoName returns undefined outside a git repo", () => {
	const root = mkdtemp();
	expect(readGitRepoName(root)).toBeUndefined();
});
