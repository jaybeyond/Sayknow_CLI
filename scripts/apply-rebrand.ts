#!/usr/bin/env bun
/**
 * apply-rebrand.ts — deterministic gajae/gjc -> sayknow/skc rebrand codemod.
 *
 * Purpose: keep the SKC fork a RE-APPLIABLE transform of upstream gajae-code,
 * not a hand-maintained diverged tree. Pull upstream (gjc) onto a clean mirror,
 * run this codemod, re-apply the thin improvement layer, verify gates.
 *
 * Usage:
 *   bun scripts/apply-rebrand.ts <target-dir> [--apply]
 *     (no --apply) = dry run: report planned content edits + path renames, no writes.
 *     --apply      = perform content rewrites and path renames in place.
 *
 * Scope: branding-only. Non-mechanical decisions (domains, camelCase compounds,
 * bare theme tokens) are intentionally NOT guessed here; they surface as residual
 * diff during validation and are encoded as explicit SPECIAL_CASES once confirmed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.join(import.meta.dir, "..");

// Ordered longest/compound-first so substrings do not pre-empt compounds.
// Each pair is applied as a literal global replace to BOTH file contents and paths.
const TOKEN_MAP: ReadonlyArray<readonly [string, string]> = [
	// gajae brand family (compound > camel > snake > bare; case variants explicit)
	["gajae-code", "sayknow-cli"],
	["Gajae-Code", "Sayknow-CLI"],
	["GajaeCode", "SayknowCli"],
	["gajae_code", "sayknow_cli"],
	["gajae-ai", "sayknow-ai"],
	// "<brand> Code" compounds → "<brand> CLI" (must precede the bare forms below).
	["Gajae Code", "Sayknow-CLI"],
	["gajae code", "sayknow-cli"],
	["GAJAE_CODE", "SAYKNOW_CLI"],
	["GAJAE CODE", "SAYKNOW-CLI"],
	["GAJAE", "SAYKNOW"],
	["Gajae", "Sayknow"],
	["gajae", "sayknow"],
	// gjc brand family (robogjc, gjcrpc, gjc-rpc, .gjc are handled as substrings here)
	["RoboGJC", "RoboSKC"],
	["RoboGjc", "RoboSkc"],
	["GJC", "SKC"],
	["Gjc", "Skc"],
	["gjc", "skc"],
	// theme rename: crustacean -> cephalopod (kebab, snake, and camelCase identifiers)
	["red-claw", "red-octopus"],
	["blue-crab", "blue-octopus"],
	["red_claw", "red_octopus"],
	["blue_crab", "blue_octopus"],
	["RedClaw", "RedOctopus"],
	["BlueCrab", "BlueOctopus"],
	["redClaw", "redOctopus"],
	["blueCrab", "blueOctopus"],
];

// Non-mechanical decisions that a literal token map would get wrong. Confirmed
// against the target tree during validation; applied AFTER TOKEN_MAP. Empty until
// validation pins the exact upstream->downstream values.
const SPECIAL_CASES: ReadonlyArray<readonly [string, string]> = [
	// Fork identity. Applied AFTER TOKEN_MAP, so upstream "gajae-ai/gajae-code" has
	// already become "sayknow-ai/sayknow-cli" and "gaebal-gajae.dev" → "gaebal-sayknow.dev".
	["sayknow-ai/sayknow-cli", "jaybeyond/Sayknow_CLI"], // repository + bugs URLs
	["https://gaebal-sayknow.dev", "https://github.com/jaybeyond/Sayknow_CLI"], // homepage
	// Repo owner / author identity → the fork owner.
	["can1357", "jaybeyond"],
	["Yeachan-Heo", "jaybeyond"],
	// GitHub repo PATH casing: the npm name is `sayknow-cli`, but the GitHub repo is
	// `Sayknow_CLI`. After the owner rewrites above, `<owner>/gajae-code` lands as
	// `jaybeyond/sayknow-cli` (hyphen/lowercase) — a non-existent repo that 404s for
	// `skc update`, the binary installer, and raw.githubusercontent schema URLs.
	// Applied AFTER the owner rewrites so it catches their output. The npm package
	// `sayknow-cli` and `@sayknow-cli/*` scope have no `jaybeyond/` prefix, so they
	// are never matched.
	["jaybeyond/sayknow-cli", "jaybeyond/Sayknow_CLI"],
	// Social links → placeholder (no Discord).
	["discord.gg/kPRgC9j3Tj", "discord.gg/your-invite"],
	["discord.gg/sj4exxQ9v", "discord.gg/your-invite"],
];

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo"]);
const SKIP_FILES = new Set(["bun.lock", "Cargo.lock", ".git"]);
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".node", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip", ".gz", ".tgz", ".tar"]);

function applyTokens(input: string): string {
	let out = input;
	for (const [from, to] of TOKEN_MAP) out = out.split(from).join(to);
	for (const [from, to] of SPECIAL_CASES) out = out.split(from).join(to);
	return out;
}

interface Plan {
	contentEdits: { file: string; hits: number }[];
	renames: { from: string; to: string }[];
}

// Collect ALL files. Binary files are still path-renamed (so directory renames
// move their assets); only their CONTENT is left untouched (see buildPlan).
function walk(dir: string, root: string, files: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(path.join(dir, entry.name), root, files);
		} else if (entry.isFile()) {
			if (SKIP_FILES.has(entry.name)) continue;
			files.push(path.join(dir, entry.name));
		}
	}
}

function isBinary(file: string): boolean {
	return BINARY_EXT.has(path.extname(file).toLowerCase());
}

// Remove directories left empty after renames (e.g. an old token-named dir whose
// files all moved). Post-order so children are pruned before parents.
function removeEmptyDirs(dir: string): boolean {
	if (SKIP_DIRS.has(path.basename(dir))) return false;
	let empty = true;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (removeEmptyDirs(child)) continue;
			empty = false;
		} else {
			empty = false;
		}
	}
	if (empty) fs.rmdirSync(dir);
	return empty;
}

function countHits(s: string): number {
	let n = 0;
	for (const [from] of TOKEN_MAP) n += s.split(from).length - 1;
	for (const [from] of SPECIAL_CASES) n += s.split(from).length - 1;
	return n;
}

function buildPlan(target: string): Plan {
	const files: string[] = [];
	walk(target, target, files);
	const plan: Plan = { contentEdits: [], renames: [] };
	for (const abs of files) {
		const rel = path.relative(target, abs);
		// Content edits: text files only.
		if (!isBinary(abs)) {
			try {
				const text = fs.readFileSync(abs, "utf8");
				const hits = countHits(text);
				if (hits > 0) plan.contentEdits.push({ file: rel, hits });
			} catch {
				// unreadable as utf8 — treat as content-inert, still rename below.
			}
		}
		// Path renames: ALL files (incl. binary), so directory renames are complete.
		const newRel = applyTokens(rel);
		if (newRel !== rel) plan.renames.push({ from: rel, to: newRel });
	}
	// Deepest paths first so child renames do not invalidate parent dirs.
	plan.renames.sort((a, b) => b.from.split("/").length - a.from.split("/").length);
	return plan;
}

function apply(target: string, plan: Plan): void {
	// 1) content rewrites (by absolute pre-rename path)
	for (const { file } of plan.contentEdits) {
		const abs = path.join(target, file);
		const text = fs.readFileSync(abs, "utf8");
		fs.writeFileSync(abs, applyTokens(text));
	}
	// 2) path renames (deepest first)
	for (const { from, to } of plan.renames) {
		const fromAbs = path.join(target, from);
		const toAbs = path.join(target, to);
		fs.mkdirSync(path.dirname(toAbs), { recursive: true });
		fs.renameSync(fromAbs, toAbs);
	}
	// 3) prune directories emptied by the renames (e.g. old token-named dirs).
	removeEmptyDirs(target);
}

function main(): void {
	const args = process.argv.slice(2);
	const doApply = args.includes("--apply");
	const target = args.find(a => !a.startsWith("--"));
	if (!target) {
		console.error("usage: bun scripts/apply-rebrand.ts <target-dir> [--apply]");
		process.exit(2);
	}
	const root = path.resolve(target);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
		console.error(`target is not a directory: ${root}`);
		process.exit(2);
	}
	const plan = buildPlan(root);
	const totalHits = plan.contentEdits.reduce((n, e) => n + e.hits, 0);
	console.log(`apply-rebrand: ${plan.contentEdits.length} files with content edits (${totalHits} token hits), ${plan.renames.length} path renames.`);
	if (!doApply) {
		console.log("\n[dry run] sample content edits:");
		for (const e of plan.contentEdits.slice(0, 15)) console.log(`  ${e.hits.toString().padStart(5)}  ${e.file}`);
		console.log("\n[dry run] sample renames:");
		for (const r of plan.renames.slice(0, 15)) console.log(`  ${r.from} -> ${r.to}`);
		console.log("\nRe-run with --apply to write changes.");
		return;
	}
	apply(root, plan);
	normalizeWithBiome(root);
	console.log("apply-rebrand: applied.");
}

/**
 * Re-apply Biome's safe fixes after the rename. Token renames change import
 * member names (e.g. `GjcPluginLoadError` -> `SkcPluginLoadError`), which shifts
 * their position in alphabetically-sorted import groups — leaving the tree dirty
 * under `biome check` and failing the CI `check:tools` gate. Biome's organize-
 * imports + format pass is deterministic, so running it here keeps the generated
 * tree byte-stable and gate-clean WITHOUT hand-maintaining the fallout of each
 * rename. Both gen-tree and extract-fork-layer's base prep call apply-rebrand, so
 * normalizing here keeps fork and base symmetric (no spurious overlay/patches).
 * Uses the repo's pinned Biome — target worktrees have no node_modules of their own.
 */
function normalizeWithBiome(root: string): void {
	const biomeBin = path.join(REPO, "node_modules", ".bin", "biome");
	if (!fs.existsSync(biomeBin)) {
		console.warn("  (biome not found in repo node_modules — skipping post-rename normalize)");
		return;
	}
	try {
		execFileSync(biomeBin, ["check", "--write", "--no-errors-on-unmatched", "."], { cwd: root, stdio: "ignore" });
	} catch {
		// `biome check --write` exits non-zero when unfixable diagnostics remain;
		// that is surfaced by the real `check:tools` gate, not by this normalize pass.
	}
}

main();
