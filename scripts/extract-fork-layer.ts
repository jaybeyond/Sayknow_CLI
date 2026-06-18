#!/usr/bin/env bun
/**
 * extract-fork-layer.ts — decompose the fork's genuine delta into re-appliable inputs.
 *
 * Given a BASE tree (= codemod + finalizer output of upstream) and the FORK tree
 * (current sayknow-fork HEAD), classify every fork file:
 *   - manifest.patch[]      → emit rebrand/patches/NN-<slug>.patch (3-way appliable)
 *   - manifest.regenerate[] → ignored (gen-tree rebuilds it)
 *   - manifest.toolingOnly  → ignored (lives in the repo, not derived from upstream)
 *   - otherwise, if it differs from BASE or BASE lacks it → copy to rebrand/overlay/
 *
 * Run AFTER `apply-rebrand` + `apply-fork-identity` have produced BASE.
 * Usage: bun scripts/extract-fork-layer.ts --base <dir> --fork <dir> [--apply]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "rebrand/manifest.json"), "utf8")) as {
	patch: string[];
	regenerate: string[];
	toolingOnly: string[];
};
const PATCH = new Set(manifest.patch);
const REGEN = new Set(manifest.regenerate);
const TOOLING = manifest.toolingOnly;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const apply = process.argv.includes("--apply");
const base = path.resolve(arg("--base") ?? "/tmp/skc-mirror");
const fork = path.resolve(arg("--fork") ?? REPO);

function isTooling(rel: string): boolean {
	return TOOLING.some(t => (t.endsWith("/") ? rel.startsWith(t) : rel === t));
}
function read(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return null;
	}
}
function sameBytes(a: string, b: string): boolean {
	try {
		return fs.readFileSync(a).equals(fs.readFileSync(b));
	} catch {
		return false;
	}
}

// Fork file list = git-tracked files on the fork branch (clean, no build cruft).
const tracked = execFileSync("git", ["-C", fork, "ls-files"], { encoding: "utf8" }).trim().split("\n");

const patches: string[] = [];
const overlays: string[] = [];
const slug = (rel: string) => rel.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

let n = 0;
for (const rel of tracked) {
	if (REGEN.has(rel) || isTooling(rel)) continue;
	const forkAbs = path.join(fork, rel);
	const baseAbs = path.join(base, rel);
	const baseExists = fs.existsSync(baseAbs);

	if (PATCH.has(rel)) {
		if (!baseExists) {
			console.warn(`! patch target missing in base (will emit add-file patch): ${rel}`);
		}
		// Unified diff with a/ b/ labels so `git apply -p1` works against BASE.
		const left = baseExists ? baseAbs : "/dev/null";
		let diff = "";
		try {
			execFileSync("diff", ["-u", "--label", `a/${rel}`, "--label", `b/${rel}`, left, forkAbs], { encoding: "utf8" });
		} catch (e: any) {
			diff = e.stdout ?? ""; // diff exits 1 when files differ — that's the patch body
		}
		if (diff) {
			patches.push(`${slug(rel)}.patch::${diff}`);
		}
		continue;
	}

	// Overlay: file is new (not in base) or differs in bytes.
	if (!baseExists || !sameBytes(baseAbs, forkAbs)) {
		overlays.push(rel);
	}
}

// Order patches deterministically and number them.
patches.sort();
console.log(`extract: ${patches.length} patches, ${overlays.length} overlay files`);

if (!apply) {
	console.log("\n[patches]");
	patches.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2, "0")}-${p.split("::")[0]}`));
	console.log("\n[overlay] (sample)");
	overlays.slice(0, 20).forEach(o => console.log(`  ${o}`));
	console.log("\nRe-run with --apply to write rebrand/overlay + rebrand/patches.");
	process.exit(0);
}

// Write patches/
const patchesDir = path.join(REPO, "rebrand/patches");
fs.rmSync(patchesDir, { recursive: true, force: true });
fs.mkdirSync(patchesDir, { recursive: true });
patches.forEach((p, i) => {
	const [name, ...rest] = p.split("::");
	fs.writeFileSync(path.join(patchesDir, `${String(i + 1).padStart(2, "0")}-${name}`), rest.join("::"));
});

// Write overlay/
const overlayDir = path.join(REPO, "rebrand/overlay");
fs.rmSync(overlayDir, { recursive: true, force: true });
for (const rel of overlays) {
	const dest = path.join(overlayDir, rel);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(path.join(fork, rel), dest);
}
console.log(`extract: wrote ${patches.length} patches + ${overlays.length} overlay files under rebrand/`);
