#!/usr/bin/env bun
/**
 * gen-tree.ts — materialize the Sayknow-CLI fork from a clean upstream checkout.
 *
 * Pipeline (deterministic, in order):
 *   1. apply-rebrand        — brand rename (gajae/gjc → sayknow/skc) + identity special-cases
 *   2. overlay              — copy rebrand/overlay/** (whole files: i18n, themes, assets, docs, tooling)
 *   3. apply-fork-identity  — stamp fork version onto metadata (AFTER overlay: identity.json is the
 *                             single version source; overlay files can't clobber the stamped version)
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
import { isVersionBearing, neutralizeVersions } from "./fork-version-neutral";

const REPO = process.cwd();
const targetArg = process.argv[2];
const target = path.resolve(targetArg ?? "");
const doBuild = process.argv.includes("--build");
// An empty arg resolves to the repo itself; generating in-place would codemod and
// version-stamp the fork's own working tree, so require an explicit distinct target.
if (!targetArg || targetArg.startsWith("--") || !fs.existsSync(target) || target === REPO) {
	console.error("usage: bun scripts/gen-tree.ts <clean-upstream-checkout> [--build]");
	if (target === REPO) console.error("refusing to generate into the fork repo itself");
	process.exit(2);
}

const run = (cmd: string, args: string[], cwd = REPO) =>
	execFileSync(cmd, args, { cwd, stdio: "inherit" });
const step = (msg: string) => console.log(`\n▸ ${msg}`);

const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "rebrand/manifest.json"), "utf8")) as {
	patch: string[];
	delete?: string[];
	toolingOnly: string[];
};
const manifestPatch = manifest.patch;

// 1. brand rename
step("apply-rebrand (brand rename + special-cases)");
run("bun", ["scripts/apply-rebrand.ts", target, "--apply"]);

// 1b. removals — upstream files the fork drops. Without this they silently
//     reappear on every sync and re-enter the workspace/build graph.
step("delete (upstream files the fork drops)");
{
	const declared = manifest;
	let removed = 0;
	const touchedDirs = new Set<string>();
	for (const rel of declared.delete ?? []) {
		const abs = path.join(target, rel);
		if (!fs.existsSync(abs)) continue;
		fs.rmSync(abs, { force: true });
		touchedDirs.add(path.dirname(abs));
		removed++;
	}
	// Prune directories the removals emptied so stale crate/package dirs do not
	// linger in the workspace globs.
	for (const dir of [...touchedDirs].sort((a, b) => b.length - a.length)) {
		let cur = dir;
		while (cur.startsWith(target) && cur !== target) {
			if (!fs.existsSync(cur) || fs.readdirSync(cur).length > 0) break;
			fs.rmdirSync(cur);
			cur = path.dirname(cur);
		}
	}
	console.log(`  removed ${removed} files`);
}

// 2. overlay whole files
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

// 3. patches (in-place edits). Patches are extracted against version-neutralized
//     text, so neutralize the generated tree first — otherwise the concrete upstream
//     version sitting in context lines rejects otherwise-clean hunks. The identity
//     stamp below rewrites the placeholders into the real fork version.
step("neutralize version text (patch context stability)");
{
	let n = 0;
	for (const rel of manifestPatch) {
		if (!isVersionBearing(rel)) continue;
		const abs = path.join(target, rel);
		if (!fs.existsSync(abs)) continue;
		const before = fs.readFileSync(abs, "utf8");
		const after = neutralizeVersions(rel, before);
		if (after !== before) {
			fs.writeFileSync(abs, after);
			n++;
		}
	}
	console.log(`  neutralized ${n} files`);
}

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

// 4b. Re-run the codemod, then re-format. Overlay and patch payloads carry
//     upstream-derived text (patch context lines, merged upstream hunks), so the
//     single pass at step 1 cannot see them; converging here is what the G2
//     idempotence gate asserts. The rename changes line lengths, so the formatter
//     must run after it or the output drifts from the committed fork tree.
step("apply-rebrand (converge after overlay + patches)");
run("bun", ["scripts/apply-rebrand.ts", target, "--apply"]);

// 5. fork identity (version stamp) — runs LAST so identity.json is the single
//     source of version truth: it rewrites both stale overlay versions and the
//     neutral placeholders left for patch-context stability.
step("apply-fork-identity (version stamp)");
run("bun", ["scripts/apply-fork-identity.ts", target, "--config", "rebrand/identity.json", "--apply"]);

// 6. Heal Rust formatting broken by the brand rename. Import ordering depends on
//     identifier names (group_imports = "StdExternalCrate"), so gjc_* -> skc_*
//     renames can desort `use` groups and fail `cargo fmt --check` inside check:rs.
step("cargo fmt (heal rename-induced Rust formatting)");
try {
	run("cargo", ["fmt", "--all"], target);
} catch {
	console.warn("  cargo fmt skipped (rustfmt unavailable?) — run `cargo fmt --all` in the output before check:rs");
}

// 7. carry the pipeline into the output so the fork can re-sync
step("tooling (carry pipeline into output)");
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
		// Regenerate lockfiles from scratch so the freshly-stamped fork version
		// propagates into them. A stale bun.lock / Cargo.lock silently ships the
		// OLD version in `skc --version` and the compiled binaries.
		fs.rmSync(path.join(target, "bun.lock"), { force: true });
		run("bun", ["install"], target);
		run("cargo", ["update", "--workspace"], target);
		run("bun", ["--cwd=packages/coding-agent", "run", "generate-docs-index"], target);
		// JSON schemas derive from the (patched) settings-schema.ts, so regenerate them after
		// patches land — otherwise check:schemas flags schemas/config.schema.json as stale.
		run("bun", ["run", "generate-schemas"], target);
		// SKC plugin bundle embeds the fork version + workflow definitions; regenerate
		// after identity + patches so plugins/*.json never drift (check:plugins).
		run("bun", ["run", "generate-plugins"], target);
		// The brand rename changes line lengths, so re-formatting is what keeps the
		// generated tree byte-identical to the committed (formatted) fork tree.
		// It needs node_modules, hence its place inside the --build branch.
		run("bun", ["run", "fmt:tools"], target);
	} catch (e) {
		console.warn("  regenerate step failed (run manually):", String(e));
	}
} else {
	console.log("\n(skipped regenerate — pass --build to run bun install + generate-docs-index)");
}

console.log(`\n✓ gen-tree complete → ${target}`);
