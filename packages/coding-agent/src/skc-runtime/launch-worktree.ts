import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type SkcLaunchWorktreeMode =
	| { enabled: false }
	| { enabled: true; detached: true; name: null }
	| { enabled: true; detached: false; name: string };

export interface ParsedLaunchWorktreeMode {
	mode: SkcLaunchWorktreeMode;
	remainingArgs: string[];
}

export interface SkcLaunchWorktreePlan {
	enabled: true;
	repoRoot: string;
	worktreePath: string;
	detached: boolean;
	baseRef: string;
	branchName: string | null;
	sourceCheckoutRoot: string;
	relativeCwd: string;
	relativeDependencyRoot: string | null;
}

export interface SkcLaunchWorktreeResult extends SkcLaunchWorktreePlan {
	created: boolean;
	reused: boolean;
	createdBranch: boolean;
	dirty?: boolean;
}

interface GitWorktreeEntry {
	path: string;
	head: string;
	branchRef: string | null;
	detached: boolean;
}

const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `git ${args.join(" ")} failed`);
}

function tryRunGit(cwd: string, args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function sanitizePathToken(value: string): string {
	const readable = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const prefix = readable || "default";
	const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${prefix}-${digest}`;
}

function resolveSourceBranchSlug(repoRoot: string, baseRef: string): string {
	const branch = tryRunGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch) return sanitizePathToken(branch);
	return `head-${baseRef.slice(0, 12)}`;
}

function branchExists(repoRoot: string, branchName: string): boolean {
	const result = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function validateBranchName(repoRoot: string, branchName: string): void {
	const result = Bun.spawnSync(["git", "check-ref-format", "--branch", branchName], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return;
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
	const raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!raw) return [];
	return raw
		.split(/\n\n+/)
		.map(chunk => chunk.trim())
		.filter(Boolean)
		.flatMap(chunk => {
			const lines = chunk
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean);
			const worktreeLine = lines.find(line => line.startsWith("worktree "));
			const headLine = lines.find(line => line.startsWith("HEAD "));
			const branchLine = lines.find(line => line.startsWith("branch "));
			if (!worktreeLine || !headLine) return [];
			return [
				{
					path: path.resolve(worktreeLine.slice("worktree ".length)),
					head: headLine.slice("HEAD ".length).trim(),
					branchRef: branchLine ? branchLine.slice("branch ".length).trim() : null,
					detached: lines.includes("detached") || !branchLine,
				},
			];
		});
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
	const resolved = path.resolve(worktreePath);
	return entries.find(entry => path.resolve(entry.path) === resolved) ?? null;
}

function describeWorktreeEntry(entry: GitWorktreeEntry): string {
	return entry.detached ? `detached HEAD ${entry.head}` : (entry.branchRef ?? `HEAD ${entry.head}`);
}

function formatWorktreeTargetMismatch(plan: SkcLaunchWorktreePlan, existing: GitWorktreeEntry): string {
	const expected = plan.detached ? `detached HEAD ${plan.baseRef}` : `branch refs/heads/${plan.branchName ?? ""}`;
	return [
		`worktree_target_mismatch:${plan.worktreePath}`,
		`SKC launch worktree target is already registered for ${describeWorktreeEntry(existing)}, but this launch expects ${expected}.`,
		`Path: ${plan.worktreePath}`,
		"Refusing to delete or reuse the conflicting worktree automatically. Safe remediation: inspect the path, commit/stash any work, then remove or prune the stale worktree with git worktree remove <path> when it is no longer needed, or choose a different --worktree name.",
	].join("\n");
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
	const expectedRef = `refs/heads/${branchName}`;
	const resolvedPath = path.resolve(worktreePath);
	return entries.some(entry => entry.branchRef === expectedRef && path.resolve(entry.path) !== resolvedPath);
}

function pruneStaleWorktreePath(repoRoot: string): void {
	runGit(repoRoot, ["worktree", "prune"]);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
	if (!fs.existsSync(worktreePath)) return null;
	const repoCommonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	const worktreeCommonDir = tryRunGit(worktreePath, ["rev-parse", "--git-common-dir"]);
	if (!repoCommonDir || !worktreeCommonDir) return null;
	if (path.resolve(repoRoot, repoCommonDir) !== path.resolve(worktreePath, worktreeCommonDir)) return null;
	const head = tryRunGit(worktreePath, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const branchRef = tryRunGit(worktreePath, ["symbolic-ref", "-q", "HEAD"]);
	return { path: path.resolve(worktreePath), head, branchRef, detached: !branchRef };
}

function resolveCanonicalRepoRoot(cwd: string): string {
	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const commonDir = tryRunGit(repoRoot, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return repoRoot;
	const resolvedCommonDir = path.resolve(repoRoot, commonDir);
	if (path.basename(resolvedCommonDir) !== ".git") return repoRoot;
	const ownerRoot = path.dirname(resolvedCommonDir);
	if (tryRunGit(ownerRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") return repoRoot;
	return ownerRoot;
}

function isWorktreeDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).length > 0;
}

function resolveOptionalWorktreeName(args: string[], index: number): { name: string | null; nextIndex: number } {
	const next = args[index + 1];
	if (!next) return { name: null, nextIndex: index };
	if (next === "--") return { name: null, nextIndex: index + 1 };
	if (next.startsWith("-")) return { name: null, nextIndex: index };
	return { name: next.trim() || null, nextIndex: index + 1 };
}

export function parseLaunchWorktreeMode(args: string[]): ParsedLaunchWorktreeMode {
	let mode: SkcLaunchWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--worktree" || arg === "-w") {
			const parsed = resolveOptionalWorktreeName(args, index);
			mode = parsed.name
				? { enabled: true, detached: false, name: parsed.name }
				: { enabled: true, detached: true, name: null };
			index = parsed.nextIndex;
			continue;
		}
		if (arg.startsWith("--worktree=")) {
			const name = arg.slice("--worktree=".length).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("-w=") || (arg.startsWith("-w") && arg.length > 2)) {
			const name = arg.startsWith("-w=") ? arg.slice("-w=".length).trim() : arg.slice(2).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		remainingArgs.push(arg);
	}

	return { mode, remainingArgs };
}

function repoRelativePath(checkoutRoot: string, targetPath: string): string {
	const relative = path.relative(checkoutRoot, targetPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`worktree_cwd_outside_checkout:${targetPath}`);
	}
	return relative;
}

function hasPackageLockMetadata(directory: string): boolean {
	return (
		fs.existsSync(path.join(directory, "bun.lock")) ||
		fs.existsSync(path.join(directory, "bun.lockb")) ||
		fs.existsSync(path.join(directory, "pnpm-lock.yaml")) ||
		fs.existsSync(path.join(directory, "pnpm-workspace.yaml")) ||
		fs.existsSync(path.join(directory, "package-lock.json")) ||
		fs.existsSync(path.join(directory, "npm-shrinkwrap.json"))
	);
}

function resolveSourceDependencyRoot(checkoutRoot: string, cwd: string): string | null {
	let current = path.resolve(cwd);
	let nearestPackageRoot: string | null = null;
	while (true) {
		if (!nearestPackageRoot && fs.existsSync(path.join(current, "package.json"))) nearestPackageRoot = current;
		if (hasPackageLockMetadata(current)) return current;
		if (current === checkoutRoot) return nearestPackageRoot;
		const parent = path.dirname(current);
		if (parent === current) return nearestPackageRoot;
		current = parent;
	}
}

export function planLaunchWorktree(
	cwd: string,
	mode: SkcLaunchWorktreeMode,
): SkcLaunchWorktreePlan | { enabled: false } {
	if (!mode.enabled) return { enabled: false };
	const sourceCheckoutRoot = fs.realpathSync.native(path.resolve(runGit(cwd, ["rev-parse", "--show-toplevel"])));
	const sourceCwd = fs.realpathSync.native(path.resolve(cwd));
	const relativeCwd = repoRelativePath(sourceCheckoutRoot, sourceCwd);
	const sourceDependencyRoot = resolveSourceDependencyRoot(sourceCheckoutRoot, sourceCwd);
	const relativeDependencyRoot =
		sourceDependencyRoot === null ? null : repoRelativePath(sourceCheckoutRoot, sourceDependencyRoot);
	const repoRoot = resolveCanonicalRepoRoot(cwd);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const branchName = mode.detached ? null : mode.name;
	if (branchName) validateBranchName(repoRoot, branchName);
	const bucket = `${path.basename(repoRoot)}.sayknow-cli-worktrees`;
	const worktreeSlug = mode.detached ? resolveSourceBranchSlug(repoRoot, baseRef) : sanitizePathToken(mode.name);
	const worktreePath = path.join(path.dirname(repoRoot), bucket, worktreeSlug);
	return {
		enabled: true,
		repoRoot,
		worktreePath,
		detached: mode.detached,
		baseRef,
		branchName,
		sourceCheckoutRoot,
		relativeCwd,
		relativeDependencyRoot,
	};
}

export function ensureLaunchWorktree(
	plan: SkcLaunchWorktreePlan | { enabled: false },
): SkcLaunchWorktreeResult | { enabled: false } {
	if (!plan.enabled) return { enabled: false };
	let allWorktrees = listWorktrees(plan.repoRoot);
	const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
	if (staleAtPath && !fs.existsSync(staleAtPath.path)) {
		pruneStaleWorktreePath(plan.repoRoot);
		allWorktrees = listWorktrees(plan.repoRoot);
	}

	const existingAtPath =
		findWorktreeByPath(allWorktrees, plan.worktreePath) ??
		readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
	const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

	if (existingAtPath) {
		let dirty = isWorktreeDirty(plan.worktreePath);
		if (plan.detached) {
			if (!existingAtPath.detached) {
				throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
			}
			if (existingAtPath.head !== plan.baseRef) {
				if (dirty) throw new Error(`worktree_dirty:${plan.worktreePath}`);
				runGit(plan.worktreePath, ["checkout", "--detach", plan.baseRef]);
				dirty = false;
			}
		} else if (existingAtPath.branchRef !== expectedBranchRef) {
			throw new Error(formatWorktreeTargetMismatch(plan, existingAtPath));
		}
		return {
			...plan,
			worktreePath: path.resolve(plan.worktreePath),
			created: false,
			reused: true,
			createdBranch: false,
			...(dirty ? { dirty: true } : {}),
		};
	}

	if (fs.existsSync(plan.worktreePath)) throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
	if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
		throw new Error(`branch_in_use:${plan.branchName}`);
	}

	fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
	const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;
	const args = ["worktree", "add"];
	if (plan.detached) args.push("--detach", plan.worktreePath, plan.baseRef);
	else if (branchAlreadyExisted) args.push(plan.worktreePath, plan.branchName ?? "");
	else args.push("-b", plan.branchName ?? "", plan.worktreePath, plan.baseRef);

	const result = Bun.spawnSync(["git", ...args], { cwd: plan.repoRoot, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) throw new Error(`branch_in_use:${plan.branchName}`);
		throw new Error(stderr || `worktree_add_failed:${args.join(" ")}`);
	}

	return {
		...plan,
		worktreePath: path.resolve(plan.worktreePath),
		created: true,
		reused: false,
		createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
	};
}

interface WorktreePackageManifest {
	packageManager?: unknown;
}

type WorktreePackageManager = "bun" | "npm" | "pnpm";

interface ResolvedWorktreePackageManager {
	name: WorktreePackageManager;
	version: string | null;
}

interface WorktreeDependencyProbes {
	isExecutableAvailable?: (name: Exclude<WorktreePackageManager, "bun">) => boolean;
	version?: (name: WorktreePackageManager) => string;
	spawnInstall?: (command: readonly string[], cwd: string) => { exitCode: number; stderr: string };
}

function fileSystemErrorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function readWorktreePackageManifest(worktreePath: string): WorktreePackageManifest | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(worktreePath, "package.json"), "utf8")) as WorktreePackageManifest;
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return null;
		throw error;
	}
}

function hasWorktreePackageMetadata(worktreePath: string, manifest: WorktreePackageManifest | null): boolean {
	return (
		manifest !== null ||
		fs.existsSync(path.join(worktreePath, "bun.lock")) ||
		fs.existsSync(path.join(worktreePath, "bun.lockb")) ||
		fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml")) ||
		fs.existsSync(path.join(worktreePath, "pnpm-workspace.yaml")) ||
		fs.existsSync(path.join(worktreePath, "package-lock.json")) ||
		fs.existsSync(path.join(worktreePath, "npm-shrinkwrap.json"))
	);
}

function declaredPackageManager(
	manifest: WorktreePackageManifest | null,
): { name: string; version: string | null } | null {
	if (typeof manifest?.packageManager !== "string") return null;
	const separator = manifest.packageManager.indexOf("@");
	const name = (separator < 0 ? manifest.packageManager : manifest.packageManager.slice(0, separator)).trim();
	if (!name) return null;
	const version = separator < 0 ? null : manifest.packageManager.slice(separator + 1).trim() || null;
	return { name, version };
}

function worktreeLockfiles(worktreePath: string): Array<{ manager: WorktreePackageManager; file: string }> {
	const candidates: Array<{ manager: WorktreePackageManager; file: string }> = [
		{ manager: "bun", file: "bun.lock" },
		{ manager: "bun", file: "bun.lockb" },
		{ manager: "pnpm", file: "pnpm-lock.yaml" },
		{ manager: "npm", file: "package-lock.json" },
		{ manager: "npm", file: "npm-shrinkwrap.json" },
	];
	return candidates.filter(candidate => fs.existsSync(path.join(worktreePath, candidate.file)));
}

function isWorktreePackageManager(value: string): value is WorktreePackageManager {
	return value === "bun" || value === "npm" || value === "pnpm";
}

function resolveWorktreePackageManager(
	worktreePath: string,
	manifest: WorktreePackageManifest | null,
): ResolvedWorktreePackageManager {
	const declared = declaredPackageManager(manifest);
	const declaredManager = declared && isWorktreePackageManager(declared.name) ? declared.name : null;
	if (declared && !declaredManager) {
		throw new Error(`worktree_dependency_manager_unsupported:${declared.name}`);
	}

	const lockfiles = worktreeLockfiles(worktreePath);
	if (lockfiles.length === 0) throw new Error("worktree_dependency_lockfile_missing");
	if (lockfiles.length > 1) {
		throw new Error(`worktree_dependency_lockfile_ambiguous:${lockfiles.map(lockfile => lockfile.file).join(",")}`);
	}
	const lockfileManager = lockfiles[0]!.manager;
	if (declaredManager && declaredManager !== lockfileManager) {
		throw new Error(`worktree_dependency_manager_mismatch:${declaredManager}:${lockfileManager}`);
	}
	return { name: declaredManager ?? lockfileManager, version: declared?.version ?? null };
}

function removeLegacySourceNodeModulesLink(sourceRoot: string, worktreePath: string): void {
	const target = path.join(worktreePath, "node_modules");
	let targetStat: fs.Stats;
	try {
		targetStat = fs.lstatSync(target);
	} catch (error) {
		if (fileSystemErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (!targetStat.isSymbolicLink()) return;

	const sourceModules = path.join(sourceRoot, "node_modules");
	const linkTarget = path.resolve(path.dirname(target), fs.readlinkSync(target));
	let linksToSource = linkTarget === path.resolve(sourceModules);
	try {
		linksToSource = linksToSource || fs.realpathSync(target) === fs.realpathSync(sourceModules);
	} catch (error) {
		if (fileSystemErrorCode(error) !== "ENOENT") throw error;
	}
	if (!linksToSource) throw new Error(`worktree_node_modules_not_local:${target}`);
	fs.unlinkSync(target);
}

function installedPackageManagerVersion(
	name: WorktreePackageManager,
	cwd: string,
	probes: WorktreeDependencyProbes,
): string {
	const testVersion = probes.version?.(name);
	if (testVersion !== undefined) return testVersion;
	if (name === "bun") return Bun.version;
	const result = Bun.spawnSync([name, "--version"], { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000 });
	if (result.exitCode !== 0) throw new Error(`worktree_dependency_manager_unavailable:${name}`);
	return result.stdout?.toString().trim() ?? "";
}

function worktreeInstallCommand(
	manager: ResolvedWorktreePackageManager,
	cwd: string,
	probes: WorktreeDependencyProbes,
): string[] {
	const args = manager.name === "npm" ? ["ci"] : ["install", "--frozen-lockfile"];
	if (manager.name !== "bun" && !(probes.isExecutableAvailable?.(manager.name) ?? Bun.which(manager.name) !== null)) {
		throw new Error(`worktree_dependency_manager_unavailable:${manager.name}`);
	}
	if (manager.version) {
		const installedVersion = installedPackageManagerVersion(manager.name, cwd, probes);
		if (installedVersion !== manager.version) {
			throw new Error(
				`worktree_dependency_manager_version_mismatch:${manager.name}:${manager.version}:${installedVersion || "unknown"}`,
			);
		}
	}
	return [manager.name, ...args];
}

function boundedInstallFailure(stderr: string, exitCode: number): string {
	const detail = stderr.trim().replace(/\s+/g, " ");
	if (!detail) return `exit_${exitCode}`;
	return detail.length <= 2048 ? detail : `${detail.slice(0, 2045)}...`;
}

function installWorktreeDependencies(
	sourceRoot: string,
	worktreePath: string,
	manifest: WorktreePackageManifest | null,
	probes: WorktreeDependencyProbes,
): void {
	removeLegacySourceNodeModulesLink(sourceRoot, worktreePath);
	const manager = resolveWorktreePackageManager(worktreePath, manifest);
	const command = worktreeInstallCommand(manager, worktreePath, probes);
	let result: { exitCode: number; stderr: string };
	try {
		if (probes.spawnInstall) {
			result = probes.spawnInstall(command, worktreePath);
		} else {
			const spawned = Bun.spawnSync(command, {
				cwd: worktreePath,
				stdout: "ignore",
				stderr: "pipe",
				timeout: 120_000,
				maxBuffer: 64 * 1024,
			});
			result = { exitCode: spawned.exitCode, stderr: spawned.stderr?.toString() ?? "" };
		}
	} catch (error) {
		const detail = error instanceof Error && error.message ? error.message : "spawn_failed";
		throw new Error(`worktree_dependency_install_failed:${manager.name}:${detail.slice(0, 2048)}`);
	}
	if (result.exitCode !== 0) {
		throw new Error(
			`worktree_dependency_install_failed:${manager.name}:${boundedInstallFailure(result.stderr, result.exitCode)}`,
		);
	}

	try {
		const installed = fs.lstatSync(path.join(worktreePath, "node_modules"));
		if (!installed.isDirectory() || installed.isSymbolicLink()) {
			throw new Error("worktree_dependency_install_not_local");
		}
	} catch (error) {
		if (fileSystemErrorCode(error) !== "ENOENT") throw error;
	}
}

/** Package worktrees own their complete lockfile-resolved dependency graph. */

export function ensureReusableNodeModules(
	sourceRoot: string,
	worktreePath: string,
	probes: WorktreeDependencyProbes = {},
): "symlink" | "present" | "missing" {
	const target = path.join(worktreePath, "node_modules");
	const manifest = readWorktreePackageManifest(worktreePath);
	if (hasWorktreePackageMetadata(worktreePath, manifest)) {
		installWorktreeDependencies(sourceRoot, worktreePath, manifest, probes);
		return "present";
	}
	if (fs.existsSync(target)) return "present";
	const source = path.join(sourceRoot, "node_modules");
	if (!fs.existsSync(source)) return "missing";
	fs.symlinkSync(source, target, "junction");
	return "symlink";
}

export function launchWorktreeCwd(plan: SkcLaunchWorktreePlan): string {
	return path.resolve(plan.worktreePath, plan.relativeCwd);
}

export function ensureLaunchWorktreeDependencies(plan: SkcLaunchWorktreePlan): "symlink" | "present" | "missing" {
	if (plan.relativeDependencyRoot === null) {
		return ensureReusableNodeModules(plan.repoRoot, plan.worktreePath);
	}
	return ensureReusableNodeModules(
		path.resolve(plan.sourceCheckoutRoot, plan.relativeDependencyRoot),
		path.resolve(plan.worktreePath, plan.relativeDependencyRoot),
	);
}

/** Result of {@link prepareLaunchWorktree}: the effective working directory, remaining args, and resolved worktree plan. */
export interface PreparedLaunchWorktree {
	cwd: string;
	args: string[];
	worktree: SkcLaunchWorktreeResult | { enabled: false };
}

export function prepareLaunchWorktree(cwd: string, args: string[]): PreparedLaunchWorktree {
	const parsed = parseLaunchWorktreeMode(args);
	const planned = planLaunchWorktree(cwd, parsed.mode);
	const ensured = ensureLaunchWorktree(planned);
	if (!ensured.enabled) return { cwd, args: parsed.remainingArgs, worktree: ensured };
	ensureLaunchWorktreeDependencies(ensured);
	return { cwd: launchWorktreeCwd(ensured), args: parsed.remainingArgs, worktree: ensured };
}
