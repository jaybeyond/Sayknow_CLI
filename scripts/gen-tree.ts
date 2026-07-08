#!/usr/bin/env bun
/**
 * gen-tree.ts — materialize the Sayknow-CLI fork from a clean upstream checkout.
 *
 * Pipeline (deterministic, in order):
 *   1. apply-rebrand        — brand rename (gajae/gjc → sayknow/skc) + identity special-cases
 *   2. apply-fork-identity  — stamp fork version (0.1.0) onto metadata
 *   3. overlay              — copy rebrand/overlay/** (whole files: i18n, themes, assets, docs, tooling)
 *   4. patches              — git apply rebrand/patches/* (in-place edits; .rej on conflict = loud)
 *   5. tooling              — copy the pipeline itself into the output so it can re-sync next time
 *   6. (--build) regenerate — docs-index, lockfiles, native build
 *
 * Usage: bun scripts/gen-tree.ts <target-dir> [--build]
 *   <target-dir> must be a CLEAN checkout of the upstream tag to fork.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = process.cwd();
const target = path.resolve(process.argv[2] ?? "");
const doBuild = process.argv.includes("--build");
if (!target || !fs.existsSync(target)) {
	console.error("usage: bun scripts/gen-tree.ts <clean-upstream-checkout> [--build]");
	process.exit(2);
}

const run = (cmd: string, args: string[], cwd = REPO) =>
	execFileSync(cmd, args, { cwd, stdio: "inherit" });
const runQuiet = (cmd: string, args: string[], cwd = REPO) =>
	execFileSync(cmd, args, { cwd, stdio: "ignore" });
const step = (msg: string) => console.log(`\n▸ ${msg}`);

// 1. brand rename
step("apply-rebrand (brand rename + special-cases)");
run("bun", ["scripts/apply-rebrand.ts", target, "--apply"]);

// 2. fork identity (version stamp)
step("apply-fork-identity (version stamp)");
run("bun", ["scripts/apply-fork-identity.ts", target, "--config", "rebrand/identity.json", "--apply"]);

// 3. overlay whole files
step("overlay (whole-file copies)");
const overlayRoot = path.join(REPO, "rebrand/overlay");
function copyTree(src: string, destRoot: string): number {
	let n = 0;
	for (const e of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, e.name);
		const rel = path.relative(overlayRoot, s);
		if (e.isDirectory()) n += copyTree(s, destRoot);
		else {
			const d = path.join(destRoot, rel);
			fs.mkdirSync(path.dirname(d), { recursive: true });
			fs.copyFileSync(s, d);
			n++;
		}
	}
	return n;
}
console.log(`  copied ${copyTree(overlayRoot, target)} files`);

// 4. patches (in-place edits)
step("patches (git apply --reject; .rej files signal conflicts)");
const patchesDir = path.join(REPO, "rebrand/patches");
const patchFiles = fs.readdirSync(patchesDir).filter(f => f.endsWith(".patch")).sort();
let rejected = 0;
for (const pf of patchFiles) {
	try {
		run("git", ["apply", "-p1", "--reject", "--whitespace=nowarn", path.join(patchesDir, pf)], target);
	} catch {
		rejected++;
		console.warn(`  ! conflict applying ${pf} (see .rej files)`);
	}
}
if (rejected) console.warn(`  ${rejected} patch(es) had conflicts — resolve .rej then re-run gates`);

// 4b. Heal Rust formatting broken by the brand rename. Import ordering depends on
//     identifier names (group_imports = "StdExternalCrate"), so gjc_* -> skc_*
//     renames can desort `use` groups and fail `cargo fmt --check` inside check:rs.
step("cargo fmt (heal rename-induced Rust formatting)");
try {
	run("cargo", ["fmt", "--all"], target);
} catch {
	console.warn("  cargo fmt skipped (rustfmt unavailable?) — run `cargo fmt --all` in the output before check:rs");
}

// 5. carry the pipeline into the output so the fork can re-sync
step("tooling (carry pipeline into output)");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "rebrand/manifest.json"), "utf8")) as { toolingOnly: string[] };
for (const t of manifest.toolingOnly) {
	const src = path.join(REPO, t.replace(/\/$/, ""));
	if (!fs.existsSync(src)) continue;
	const dest = path.join(target, t.replace(/\/$/, ""));
	if (fs.statSync(src).isDirectory()) {
		fs.cpSync(src, dest, { recursive: true });
	} else {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(src, dest);
	}
}

// 6. optional heavy regeneration
if (doBuild) {
	step("regenerate (docs-index, lockfiles)");
	try {
		run("bun", ["install"], target);
		runQuiet("cargo", ["metadata", "--format-version", "1"], target);
		run("bun", ["--cwd=packages/coding-agent", "run", "generate-docs-index"], target);
		// JSON schemas derive from the (patched) settings-schema.ts, so regenerate them after
		// patches land — otherwise check:schemas flags schemas/config.schema.json as stale.
		run("bun", ["run", "generate-schemas"], target);
	} catch (e) {
		console.warn("  regenerate step failed (run manually):", String(e));
	}
} else {
	console.log("\n(skipped regenerate — pass --build to run bun install + generate-docs-index)");
}

console.log(`\n✓ gen-tree complete → ${target}`);
