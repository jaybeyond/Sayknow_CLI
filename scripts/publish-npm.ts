#!/usr/bin/env bun
/**
 * publish-npm.ts — publish the Sayknow-CLI workspace packages to npm.
 *
 * Uses `bun publish` (NOT `npm publish`): bun resolves `catalog:`/`workspace:`
 * protocol deps to concrete versions at pack time, so the published packages
 * actually install. `npm publish` would leave `catalog:` in the tarball and break
 * `bun install -g sayknow-cli`.
 *
 * Packages are published in dependency (topological) order so each dependency is
 * already on the registry when its dependents publish. Already-published versions
 * are skipped.
 *
 * Prereqs (you must do these — they need your npm account):
 *   1. Create the @sayknow-cli org/scope on npmjs.com (Settings → Organizations).
 *   2. `bunx npm login`  (or `npm login`)
 *
 * Usage:
 *   bun scripts/publish-npm.ts --dry-run     # pack + report, no upload
 *   bun scripts/publish-npm.ts               # publish for real
 *
 * Note: @sayknow-cli/natives bundles a prebuilt .node for the CURRENT platform
 * only. A publish from one machine works on that OS/arch; cross-platform support
 * needs the CI build matrix (scripts/ci-release-build-binaries.ts). Build it first
 * with `bun run build:native`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = process.cwd();
const dryRun = process.argv.includes("--dry-run");

// Dependency (topological) publish order: a package appears after everything it
// depends on. Names are the directory under packages/.
const ORDER = [
	"natives",
	"bridge-client",
	"utils",
	"ai",
	"tui",
	"stats",
	"agent", // @sayknow-cli/agent-core
	"coding-agent",
	"sayknow-cli",
] as const;

function pkgJson(dir: string): { name: string; version: string; private?: boolean } {
	return JSON.parse(fs.readFileSync(path.join(REPO, "packages", dir, "package.json"), "utf8"));
}

/** Is name@version already on the registry? */
function alreadyPublished(name: string, version: string): boolean {
	try {
		const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out === version;
	} catch {
		return false; // 404 = not published
	}
}

console.log(`▸ ${dryRun ? "DRY-RUN" : "PUBLISH"} — ${ORDER.length} packages, in dependency order\n`);

let published = 0;
let skipped = 0;
for (const dir of ORDER) {
	const { name, version, private: isPrivate } = pkgJson(dir);
	if (isPrivate) {
		console.log(`  skip ${name} (private)`);
		continue;
	}
	if (!dryRun && alreadyPublished(name, version)) {
		console.log(`  skip ${name}@${version} (already on npm)`);
		skipped++;
		continue;
	}
	console.log(`  → ${name}@${version}`);
	// `bun publish --dry-run` still requires auth, so dry-run uses `bun pm pack
	// --dry-run` instead — it resolves catalog:/workspace: deps the same way and
	// needs no login, giving a true offline preview of the tarball.
	const cmd = dryRun ? ["pm", "pack", "--dry-run"] : ["publish", "--access", "public"];
	try {
		execFileSync("bun", cmd, { cwd: path.join(REPO, "packages", dir), stdio: "inherit" });
		published++;
	} catch (e) {
		console.error(`\n✗ Failed publishing ${name}@${version}. Fix and re-run (already-published packages are skipped).`);
		process.exit(1);
	}
}

console.log(`\n✓ ${dryRun ? "Dry-run" : "Published"}: ${published} package(s), ${skipped} skipped.`);
if (dryRun) console.log("  Remove --dry-run to publish for real (after `bunx npm login`).");
