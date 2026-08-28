import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@sayknow-cli/coding-agent/cli/args";
import { buildDefaultTmuxLaunchPlan } from "@sayknow-cli/coding-agent/skc-runtime/launch-tmux";
import {
	ensureLaunchWorktree,
	ensureReusableNodeModules,
	parseLaunchWorktreeMode,
	planLaunchWorktree,
	prepareLaunchWorktree,
} from "@sayknow-cli/coding-agent/skc-runtime/launch-worktree";

const cleanupRoots: string[] = [];

function run(command: string, args: string[], cwd: string): string {
	const result = Bun.spawnSync([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	throw new Error(result.stderr.toString().trim() || `${command} ${args.join(" ")} failed`);
}

function testSlug(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

async function createRepo(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanupRoots.push(root);
	run("git", ["init"], root);
	run("git", ["config", "user.email", "test@example.com"], root);
	run("git", ["config", "user.name", "Test User"], root);
	await Bun.write(path.join(root, "README.md"), "hello\n");
	run("git", ["add", "README.md"], root);
	run("git", ["commit", "-m", "init"], root);
	return root;
}

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		const bucket = path.join(path.dirname(root), `${path.basename(root)}.sayknow-cli-worktrees`);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], root));
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, branchSlug)], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		Bun.spawnSync(["git", "worktree", "remove", "--force", path.join(bucket, "feature-demo")], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(bucket, { recursive: true, force: true });
	}
});

describe("default launch worktrees", () => {
	it("parses and strips launch worktree flags", () => {
		expect(parseLaunchWorktreeMode(["--worktree", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["--worktree", "--model", "opus"]).mode).toEqual({
			enabled: true,
			detached: true,
			name: null,
		});
		expect(parseLaunchWorktreeMode(["--worktree=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w", "--", "hello"])).toEqual({
			mode: { enabled: true, detached: true, name: null },
			remainingArgs: ["hello"],
		});
		expect(parseLaunchWorktreeMode(["-w=feature/demo", "hello"])).toEqual({
			mode: { enabled: true, detached: false, name: "feature/demo" },
			remainingArgs: ["hello"],
		});
	});

	it("creates and reuses a detached launch worktree beside the source repo", async () => {
		const repo = await createRepo("skc-launch-worktree-");
		await fs.mkdir(path.join(repo, "node_modules"));

		const first = prepareLaunchWorktree(repo, ["--worktree", "--", "hello"]);
		const branchSlug = testSlug(run("git", ["branch", "--show-current"], repo));
		const expectedPath = path.join(path.dirname(repo), `${path.basename(repo)}.sayknow-cli-worktrees`, branchSlug);

		expect(await fs.realpath(first.cwd)).toBe(await fs.realpath(expectedPath));
		expect(first.args).toEqual(["hello"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		expect(first.worktree.enabled && first.worktree.detached).toBe(true);
		expect(await Bun.file(path.join(expectedPath, ".git")).exists()).toBe(true);
		expect((await fs.lstat(path.join(expectedPath, "node_modules"))).isSymbolicLink()).toBe(true);

		const second = prepareLaunchWorktree(repo, ["--worktree", "--slow", "opus"]);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
	});

	for (const manager of ["bun", "npm", "pnpm"] as const) {
		it.skipIf(manager !== "bun" && Bun.which(manager) === null)(
			`installs ${manager} dependencies inside the worktree from its lockfile`,
			async () => {
				const repo = await createRepo(`skc-launch-worktree-${manager}-package-`);
				const version = run(manager, ["--version"], repo);
				const rootManifest = {
					name: "workspace-root",
					private: true,
					packageManager: `${manager}@${version}`,
					...(manager === "pnpm" ? {} : { workspaces: ["packages/*"] }),
					devDependencies: { "@scope/app": manager === "npm" ? "1.0.0" : "workspace:*" },
				};
				await Bun.write(path.join(repo, "package.json"), JSON.stringify(rootManifest));
				if (manager === "pnpm")
					await Bun.write(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
				await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
				await Bun.write(
					path.join(repo, "packages", "app", "package.json"),
					JSON.stringify({ name: "@scope/app", version: "1.0.0", exports: "./index.js" }),
				);
				await Bun.write(path.join(repo, "packages", "app", "index.js"), 'export const source = "worktree";\n');
				run(manager, ["install"], repo);
				const lockfile =
					manager === "bun"
						? (await Bun.file(path.join(repo, "bun.lock")).exists())
							? "bun.lock"
							: "bun.lockb"
						: manager === "pnpm"
							? "pnpm-lock.yaml"
							: "package-lock.json";
				run(
					"git",
					["add", "package.json", lockfile, "packages", ...(manager === "pnpm" ? ["pnpm-workspace.yaml"] : [])],
					repo,
				);
				run("git", ["commit", "-m", "workspace package"], repo);

				const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: `${manager}-workspace` });
				if (!plan.enabled) throw new Error("expected enabled worktree plan");
				const worktree = ensureLaunchWorktree(plan);
				if (!worktree.enabled) throw new Error("expected enabled worktree");
				await fs.symlink(
					path.join(repo, "node_modules"),
					path.join(worktree.worktreePath, "node_modules"),
					"junction",
				);

				expect(ensureReusableNodeModules(repo, worktree.worktreePath)).toBe("present");
				const launched = prepareLaunchWorktree(repo, ["--worktree", `${manager}-workspace`]);
				const worktreeModules = path.join(launched.cwd, "node_modules");
				expect((await fs.lstat(worktreeModules)).isSymbolicLink()).toBe(false);
				expect(await fs.realpath(path.join(worktreeModules, "@scope", "app"))).toBe(
					path.join(launched.cwd, "packages", "app"),
				);
				expect(await fs.realpath(path.join(repo, "node_modules", "@scope", "app"))).toBe(
					path.join(repo, "packages", "app"),
				);
			},
			30_000,
		);
	}

	it("preserves a nested package cwd and installs at its mapped lockfile root", async () => {
		const repo = await createRepo("skc-launch-worktree-nested-package-");
		const packageRoot = path.join(repo, "apps", "demo");
		await fs.mkdir(packageRoot, { recursive: true });
		await fs.mkdir(path.join(repo, "packages", "local-dep"), { recursive: true });
		await Bun.write(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "nested-package",
				version: "1.0.0",
				packageManager: `bun@${Bun.version}`,
				dependencies: { "local-dep": "file:../../packages/local-dep" },
			}),
		);
		await Bun.write(
			path.join(repo, "packages", "local-dep", "package.json"),
			JSON.stringify({ name: "local-dep", version: "1.0.0" }),
		);
		await Bun.write(path.join(repo, "packages", "local-dep", "index.js"), 'export const source = "worktree";\n');
		run("bun", ["install"], packageRoot);
		const lockfile = (await Bun.file(path.join(packageRoot, "bun.lock")).exists()) ? "bun.lock" : "bun.lockb";
		run("git", ["add", "apps", "packages", path.join("apps", "demo", lockfile)], repo);
		run("git", ["commit", "-m", "nested package"], repo);
		await Bun.write(
			path.join(repo, "packages", "local-dep", "index.js"),
			'export const source = "source-mutated";\n',
		);

		const launched = prepareLaunchWorktree(packageRoot, ["--worktree", "nested-package"]);
		const worktreeRoot = launched.worktree.enabled ? launched.worktree.worktreePath : "";
		expect(launched.cwd).toBe(path.join(worktreeRoot, "apps", "demo"));
		expect((await fs.lstat(path.join(launched.cwd, "node_modules"))).isSymbolicLink()).toBe(false);
		expect(await Bun.file(path.join(launched.cwd, "node_modules", "local-dep", "index.js")).text()).toContain(
			'"worktree"',
		);
		expect(await Bun.file(path.join(repo, "packages", "local-dep", "index.js")).text()).toContain('"source-mutated"');
	});

	it("fails closed when the lockfile package manager is unavailable", async () => {
		const repo = await createRepo("skc-launch-worktree-unavailable-manager-");
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({ name: "package-root", version: "1.0.0", packageManager: "npm@11.5.2" }),
		);
		await Bun.write(
			path.join(repo, "package-lock.json"),
			JSON.stringify({
				name: "package-root",
				version: "1.0.0",
				lockfileVersion: 3,
				requires: true,
				packages: { "": { name: "package-root", version: "1.0.0" } },
			}),
		);
		run("git", ["add", "package.json", "package-lock.json"], repo);
		run("git", ["commit", "-m", "npm package"], repo);

		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "unavailable-manager" });
		if (!plan.enabled) throw new Error("expected enabled worktree plan");
		const worktree = ensureLaunchWorktree(plan);
		if (!worktree.enabled) throw new Error("expected enabled worktree");
		expect(() =>
			ensureReusableNodeModules(repo, worktree.worktreePath, {
				isExecutableAvailable: () => false,
			}),
		).toThrow("worktree_dependency_manager_unavailable:npm");

		expect(() =>
			ensureReusableNodeModules(repo, worktree.worktreePath, {
				isExecutableAvailable: () => true,
				version: () => "10.0.0",
			}),
		).toThrow("worktree_dependency_manager_version_mismatch:npm:11.5.2:10.0.0");

		let boundedFailure: Error | undefined;
		try {
			ensureReusableNodeModules(repo, worktree.worktreePath, {
				isExecutableAvailable: () => true,
				version: () => "11.5.2",
				spawnInstall: () => ({ exitCode: 1, stderr: "x".repeat(1024 * 1024) }),
			});
		} catch (error) {
			boundedFailure = error instanceof Error ? error : new Error(String(error));
		}
		expect(boundedFailure?.message).toStartWith("worktree_dependency_install_failed:npm:");
		expect(boundedFailure?.message.length).toBeLessThan(2200);
	});

	it("refuses an external node_modules link instead of installing through it", async () => {
		const repo = await createRepo("skc-launch-worktree-external-modules-");
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({
				name: "workspace-root",
				private: true,
				packageManager: `bun@${Bun.version}`,
				workspaces: ["packages/*"],
				devDependencies: { "@scope/app": "workspace:*" },
			}),
		);
		await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
		await Bun.write(
			path.join(repo, "packages", "app", "package.json"),
			JSON.stringify({ name: "@scope/app", version: "1.0.0" }),
		);
		run("bun", ["install"], repo);
		const lockfile = (await Bun.file(path.join(repo, "bun.lock")).exists()) ? "bun.lock" : "bun.lockb";
		run("git", ["add", "package.json", lockfile, "packages"], repo);
		run("git", ["commit", "-m", "workspace package"], repo);

		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "external-modules" });
		if (!plan.enabled) throw new Error("expected enabled worktree plan");
		const worktree = ensureLaunchWorktree(plan);
		if (!worktree.enabled) throw new Error("expected enabled worktree");
		const externalModules = path.join(repo, "external-node-modules");
		await fs.mkdir(externalModules);
		await fs.symlink(externalModules, path.join(worktree.worktreePath, "node_modules"), "junction");

		expect(() => ensureReusableNodeModules(repo, worktree.worktreePath)).toThrow(/worktree_node_modules_not_local:/);
		expect(await fs.realpath(path.join(worktree.worktreePath, "node_modules"))).toBe(externalModules);
	});

	it("requires one supported lockfile for package worktrees", async () => {
		const repo = await createRepo("skc-launch-worktree-lockfile-errors-");
		await Bun.write(
			path.join(repo, "package.json"),
			JSON.stringify({
				name: "workspace-root",
				private: true,
				packageManager: `bun@${Bun.version}`,
				workspaces: [],
			}),
		);
		run("git", ["add", "package.json"], repo);
		run("git", ["commit", "-m", "package without lockfile"], repo);

		const plan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "missing-lockfile" });
		if (!plan.enabled) throw new Error("expected enabled worktree plan");
		const worktree = ensureLaunchWorktree(plan);
		if (!worktree.enabled) throw new Error("expected enabled worktree");

		expect(() => ensureReusableNodeModules(repo, worktree.worktreePath)).toThrow(
			"worktree_dependency_lockfile_missing",
		);

		await Bun.write(path.join(worktree.worktreePath, "bun.lock"), "");
		await Bun.write(path.join(worktree.worktreePath, "bun.lockb"), "");
		expect(() => ensureReusableNodeModules(repo, worktree.worktreePath)).toThrow(
			"worktree_dependency_lockfile_ambiguous:bun.lock,bun.lockb",
		);
	});

	it("creates launch worktrees beside the canonical source repo when launched from an existing worktree", async () => {
		const repo = await fs.realpath(await createRepo("skc-launch-nested-source-worktree-"));
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		const second = prepareLaunchWorktree(first.cwd, ["--worktree", "feature/nested"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.sayknow-cli-worktrees`,
			testSlug("feature/nested"),
		);

		expect(second.worktree.enabled && second.worktree.repoRoot).toBe(repo);
		expect(await fs.realpath(second.cwd)).toBe(await fs.realpath(expectedPath));
		expect(
			second.cwd.includes(`.sayknow-cli-worktrees${path.sep}${path.basename(first.cwd)}.sayknow-cli-worktrees`),
		).toBe(false);
	});

	it("reports actionable diagnostics when the deterministic detached target is a different branch", async () => {
		const repo = await createRepo("skc-launch-target-mismatch-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		run("git", ["checkout", "-b", "other-agent-work"], first.cwd);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(
			/worktree_target_mismatch:[\s\S]*already registered for refs\/heads\/other-agent-work[\s\S]*Refusing to delete or reuse the conflicting worktree automatically[\s\S]*git worktree remove/,
		);
	});

	it("updates a clean reused detached launch worktree when source HEAD advances", async () => {
		const repo = await createRepo("skc-launch-advance-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);
		const nextHead = run("git", ["rev-parse", "HEAD"], repo);

		const second = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(second.worktree.enabled && second.worktree.reused).toBe(true);
		expect(run("git", ["rev-parse", "HEAD"], second.cwd)).toBe(nextHead);
	});

	it("rejects dirty detached launch worktrees when source HEAD advances", async () => {
		const repo = await createRepo("skc-launch-dirty-worktree-");
		const first = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(first.worktree.enabled && first.worktree.created).toBe(true);
		await Bun.write(path.join(first.cwd, "dirty.txt"), "dirty\n");

		await Bun.write(path.join(repo, "next.txt"), "next\n");
		run("git", ["add", "next.txt"], repo);
		run("git", ["commit", "-m", "next"], repo);

		expect(() => prepareLaunchWorktree(repo, ["--worktree"])).toThrow(/worktree_dirty:/);
	});

	it("creates named worktrees without reusing a dirty detached source-branch worktree", async () => {
		const repo = await createRepo("skc-launch-dirty-detached-named-worktree-");
		const detached = prepareLaunchWorktree(repo, ["--worktree"]);
		expect(detached.worktree.enabled && detached.worktree.created).toBe(true);
		await Bun.write(path.join(detached.cwd, "dirty.txt"), "dirty\n");

		const named = prepareLaunchWorktree(repo, ["--worktree", "feat/hud-ui-alignment"]);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.sayknow-cli-worktrees`,
			testSlug("feat/hud-ui-alignment"),
		);

		expect(await fs.realpath(named.cwd)).toBe(await fs.realpath(expectedPath));
		expect(named.worktree.enabled && named.worktree.branchName).toBe("feat/hud-ui-alignment");
		expect(run("git", ["branch", "--show-current"], named.cwd)).toBe("feat/hud-ui-alignment");
	});

	it("creates named launch worktrees from reusable branch names", async () => {
		const repo = await createRepo("skc-launch-named-worktree-");
		const planned = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const ensured = ensureLaunchWorktree(planned);
		const expectedPath = path.join(
			path.dirname(repo),
			`${path.basename(repo)}.sayknow-cli-worktrees`,
			testSlug("feature/demo"),
		);

		expect(ensured.enabled && (await fs.realpath(ensured.worktreePath))).toBe(await fs.realpath(expectedPath));
		expect(ensured.enabled && ensured.branchName).toBe("feature/demo");
		expect(run("git", ["branch", "--show-current"], expectedPath)).toBe("feature/demo");
	});

	it("keeps launch worktree slugs collision-resistant for similar branch names", async () => {
		const repo = await createRepo("skc-launch-collision-worktree-");
		const slashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature/demo" });
		const dashPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature-demo" });
		const casePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "Feature" });
		const lowerPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "feature" });
		const unicodePlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "é" });
		const asciiPlan = planLaunchWorktree(repo, { enabled: true, detached: false, name: "e9" });

		expect(slashPlan.enabled && slashPlan.worktreePath.endsWith(testSlug("feature/demo"))).toBe(true);
		expect(dashPlan.enabled && dashPlan.worktreePath.endsWith(testSlug("feature-demo"))).toBe(true);
		expect(slashPlan.enabled && dashPlan.enabled && slashPlan.worktreePath).not.toBe(
			dashPlan.enabled && dashPlan.worktreePath,
		);
		expect(casePlan.enabled && lowerPlan.enabled && casePlan.worktreePath).not.toBe(
			lowerPlan.enabled && lowerPlan.worktreePath,
		);
		expect(unicodePlan.enabled && asciiPlan.enabled && unicodePlan.worktreePath).not.toBe(
			asciiPlan.enabled && asciiPlan.worktreePath,
		);
	});

	it("uses the launch worktree as the generated tmux cwd", async () => {
		const repo = await createRepo("skc-session-worktree-");
		const launch = prepareLaunchWorktree(repo, ["--worktree"]);
		const parsed = { messages: [], fileArgs: [], unknownFlags: new Map(), tmux: true } satisfies Args;
		const plan = buildDefaultTmuxLaunchPlan({
			parsed,
			rawArgs: launch.args,
			cwd: launch.cwd,
			env: {},
			argv: ["/usr/local/bin/skc"],
			execPath: "/bin/bun",
			platform: "darwin",
			tty: { stdin: true, stdout: true },
			tmuxAvailable: true,
			existingBranchSessionName: null,
		});

		expect(plan?.cwd).toBe(launch.cwd);
		expect(plan?.newSessionArgs).toContain(launch.cwd);
	});
});
