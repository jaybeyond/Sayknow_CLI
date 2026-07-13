#!/usr/bin/env bun

/**
 * Canonical dev linker for the `skc` CLI.
 *
 * Makes the global `skc` command run THIS checkout's TypeScript source
 * (`packages/coding-agent/src/cli.ts`) instead of a compiled binary or a
 * published npm install. Running from source is the only mode that can
 * dynamically load `@sayknow-cli/natives` for skills — a `bun build --compile`
 * standalone binary cannot, which surfaces as:
 *
 *   Failed to load skill: Cannot find module '@sayknow-cli/natives' from '/$bunfs/root/skc'
 *
 * Usage:
 *   bun scripts/dev-link.ts            # link `skc` -> src/cli.ts on PATH
 *   bun scripts/dev-link.ts --check    # doctor: fail if `skc` has drifted
 *
 * Env:
 *   SKC_DEV_LINK_DIR   override the target bin dir (default ~/.local/bin)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const cliSource = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const cliSourceReal = realpath(cliSource) ?? cliSource;

const HOME = os.homedir();
const PATH_SEP = process.platform === "win32" ? ";" : ":";
const targetDir = process.env.SKC_DEV_LINK_DIR ?? path.join(HOME, ".local", "bin");

function realpath(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}

/** Does the symlink/file exist (without following the link)? */
function lexists(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

function pathDirs(): string[] {
	return (process.env.PATH ?? "").split(PATH_SEP).filter(Boolean);
}

function isOnPath(dir: string): boolean {
	const want = realpath(dir) ?? dir;
	return pathDirs().some(d => (realpath(d) ?? d) === want);
}

interface SkcHit {
	dir: string;
	file: string;
	real: string | null;
}

/** All `skc` entries on PATH, in resolution order (first wins). */
function findSkcOnPath(): SkcHit[] {
	const hits: SkcHit[] = [];
	const seen = new Set<string>();
	for (const dir of pathDirs()) {
		const file = path.join(dir, "skc");
		if (seen.has(file) || !lexists(file)) continue;
		seen.add(file);
		hits.push({ dir, file, real: realpath(file) });
	}
	return hits;
}

function describe(real: string | null): string {
	if (!real) return "broken symlink / unresolved";
	if (real === cliSourceReal) return "workspace source (cli.ts) — OK";
	if (/[/\\]dist[/\\]/.test(real)) return `compiled binary: ${real}`;
	if (real.includes("$bunfs")) return `compiled binary (bunfs): ${real}`;
	if (real.includes(`${path.sep}node_modules${path.sep}sayknow-cli${path.sep}`)) {
		return `published wrapper: ${real}`;
	}
	return real;
}

function smokeTest(skcPath: string): { ok: boolean; output: string } {
	const res = Bun.spawnSync([skcPath, "--smoke-test"], { stdout: "pipe", stderr: "pipe" });
	const output = `${res.stdout.toString()}${res.stderr.toString()}`.trim();
	return { ok: res.exitCode === 0 && output.includes("smoke-test: ok"), output };
}

function assertResolvedSkcIsSource(winner: SkcHit | undefined): void {
	if (!winner || winner.real === cliSourceReal) return;

	console.error("");
	console.error("✗ Linked, but `skc` still resolves to a different command earlier on PATH.");
	console.error(`  Resolved: ${winner.file}`);
	console.error(`       -> ${describe(winner.real)}`);
	console.error(`  Expected source: ${cliSourceReal}`);
	console.error(`  The managed link was created at: ${path.join(targetDir, "skc")}`);
	console.error("  Move the managed link directory earlier on PATH or remove the shadowing command.");
	process.exit(1);
}

/**
 * Guard: `bun install` run from another worktree rewrites the
 * `node_modules/@sayknow-cli/*` workspace symlinks to point at THAT checkout,
 * and a later `bun install` here won't repair them (name+version still match,
 * so bun considers the install satisfied). Fail loudly instead of letting the
 * build break with confusing missing-export errors.
 */
function assertWorkspaceLinksLocal(): void {
	const repoRootReal = realpath(repoRoot) ?? repoRoot;
	const scopeDir = path.join(repoRoot, "node_modules", "@sayknow-cli");
	let entries: string[];
	try {
		entries = fs.readdirSync(scopeDir);
	} catch {
		return; // no install yet — nothing to validate
	}

	const stale: Array<{ link: string; real: string }> = [];
	for (const entry of entries) {
		const link = path.join(scopeDir, entry);
		try {
			if (!fs.lstatSync(link).isSymbolicLink()) continue;
		} catch {
			continue;
		}
		const real = realpath(link);
		if (real && !real.startsWith(repoRootReal + path.sep)) {
			stale.push({ link, real });
		}
	}

	if (stale.length === 0) return;

	console.error("✗ Workspace symlinks point outside this checkout (stale cross-worktree install):");
	for (const { link, real } of stale) {
		console.error(`    ${link}`);
		console.error(`      -> ${real}`);
	}
	console.error("  Fix: rm -rf node_modules/@sayknow-cli && bun install");
	process.exit(1);
}

function assertSourceExists(): void {
	if (!fs.existsSync(cliSource)) {
		console.error(`✗ Cannot find CLI source at ${cliSource}`);
		console.error("  Run this from the sayknow-cli checkout.");
		process.exit(1);
	}
}

/** Doctor: verify the `skc` the shell resolves is this checkout's source. */
function check(): never {
	assertSourceExists();
	assertWorkspaceLinksLocal();
	const hits = findSkcOnPath();
	if (hits.length === 0) {
		console.error("✗ `skc` is not on PATH.");
		console.error("  Fix: bun run dev:link");
		process.exit(1);
	}

	const winner = hits[0];
	const onSource = winner.real === cliSourceReal;
	console.log(`skc resolves to: ${winner.file}`);
	console.log(`            -> ${describe(winner.real)}`);

	if (!onSource) {
		console.error("");
		console.error("✗ `skc` is NOT this checkout's source — it has drifted.");
		console.error(`  Expected: ${cliSourceReal}`);
		console.error("  Fix: bun run dev:link");
		process.exit(1);
	}

	const smoke = smokeTest(winner.file);
	if (!smoke.ok) {
		console.error("");
		console.error("✗ `skc --smoke-test` failed (natives/worker did not load):");
		console.error(smoke.output.replace(/^/gm, "  "));
		console.error("  Fix: bun run dev:link  (and rebuild natives if needed: bun run build:native)");
		process.exit(1);
	}

	console.log("✓ skc runs this checkout's source and natives load (smoke-test: ok).");
	process.exit(0);
}

/** Link: point `skc` at this checkout's source on PATH. */
function link(): never {
	assertSourceExists();
	assertWorkspaceLinksLocal();

	if (process.platform === "win32") {
		console.error("dev:link targets Unix-like systems (symlink into ~/.local/bin).");
		console.error("On Windows, install the dev CLI with Bun instead:");
		console.error("  bun --cwd=packages/coding-agent link");
		process.exit(1);
	}

	fs.mkdirSync(targetDir, { recursive: true });
	const target = path.join(targetDir, "skc");

	if (lexists(target)) {
		fs.rmSync(target, { force: true });
	}
	fs.symlinkSync(cliSource, target);
	console.log(`✓ Linked ${target} -> ${cliSource}`);

	if (!isOnPath(targetDir)) {
		console.warn(`! ${targetDir} is not on your PATH — add it so \`skc\` resolves:`);
		console.warn(`    export PATH="${targetDir}:$PATH"`);
	}

	// The repo's own `node_modules/.bin/skc` is recreated by every `bun install`
	// and sits earlier on PATH, so remove it automatically instead of nagging.
	const repoBinShadow = path.join(repoRoot, "node_modules", ".bin", "skc");

	// Warn about any drifted `skc` that shadows the link (earlier on PATH).
	for (const hit of findSkcOnPath()) {
		if (hit.file === target) break; // our link wins from here on
		if (hit.real === cliSourceReal) continue; // another correct source link — harmless
		if (realpath(hit.file) === realpath(repoBinShadow) || hit.file === repoBinShadow) {
			fs.rmSync(hit.file, { force: true });
			console.log(`✓ Removed in-repo shadow: ${hit.file}`);
			continue;
		}
		console.warn("");
		console.warn(`! A different \`skc\` shadows the dev link (earlier on PATH): ${hit.file}`);
		console.warn(`    -> ${describe(hit.real)}`);
		if (hit.dir === path.join(HOME, ".bun", "bin")) {
			console.warn("    Remove the published global install: bun remove -g sayknow-cli");
		} else {
			console.warn(`    Remove it: rm "${hit.file}"`);
		}
	}

	const winner = findSkcOnPath()[0];
	assertResolvedSkcIsSource(winner);

	const smokePath = winner?.file ?? target;
	const smoke = smokeTest(smokePath);
	if (!smoke.ok) {
		console.error("");
		console.error("✗ Linked, but `skc --smoke-test` failed (natives/worker did not load):");
		console.error(smoke.output.replace(/^/gm, "  "));
		console.error("  Try rebuilding natives: bun run build:native");
		process.exit(1);
	}
	console.log("✓ smoke-test: ok — `skc` runs this checkout's source with natives loaded.");
	process.exit(0);
}

if (process.argv.includes("--check")) {
	check();
} else {
	link();
}
