#!/usr/bin/env bun
/**
 * apply-fork-identity.ts — stamp PARAMETRIC fork identity onto a rebranded tree.
 *
 * These are per-release fork DECISIONS (not brand renames), applied AFTER the
 * codemod. They are written as minimal, format-preserving line edits so the file
 * stays byte-identical to upstream except the stamped value — never a full
 * JSON/TOML re-serialize (which would reflow whitespace and explode the diff).
 *
 * Currently stamps the fork VERSION onto:
 *   - release workspace package.json files ("version": "..."), excluding private benchmark packages with fixed local versions
 *   - the root catalog              (@sayknow-cli/*: "...")
 *   - Cargo.toml                    ([workspace.package] version = "...")
 *
 * Config: rebrand/identity.json  ->  { "version": "0.1.0" }
 *
 * Usage: bun scripts/apply-fork-identity.ts <target-dir> [--config <path>] [--apply]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".turbo", "target"]);
const PACKAGE_VERSION_EXCEPTIONS = new Set([
	"@sayknow-cli/orchestration-token-benchmark",
	"@sayknow-cli/typescript-edit-benchmark",
]);


interface Identity {
	version: string;
}

// Only the workspace's OWN packages get the fork version — not vendored/example
// package.json files nested deeper (e.g. grok-cli-vendor, extension examples),
// which keep their upstream versions. Mirrors the root `workspaces.packages` globs:
// `packages/*` and `python/roboskc/web`.
function findPackageJsons(root: string, out: string[]): void {
	const packagesDir = path.join(root, "packages");
	if (fs.existsSync(packagesDir)) {
		for (const e of fs.readdirSync(packagesDir, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			const pj = path.join(packagesDir, e.name, "package.json");
			if (fs.existsSync(pj)) out.push(pj);
		}
	}
	const webPj = path.join(root, "python/roboskc/web/package.json");
	if (fs.existsSync(webPj)) out.push(webPj);
}

function packageName(text: string): string | undefined {
	const match = text.match(/"name"\s*:\s*"([^"]+)"/);
	return match?.[1];
}
/** Replace ONLY the first top-level `"version": "..."` (package.json convention). */
function stampPackageVersion(text: string, version: string): string {
	return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
}

/** Replace every `"@sayknow-cli/<pkg>": "..."` pin (root catalog) with the version. */
function stampCatalog(text: string, version: string): string {
	return text.replace(/("@sayknow-cli\/[A-Za-z0-9-]+"\s*:\s*")[^"]*(")/g, `$1${version}$2`);
}

/** Replace the `[workspace.package]` version in Cargo.toml. */
function stampCargoWorkspaceVersion(text: string, version: string): string {
	return text.replace(/(\[workspace\.package\][\s\S]*?\bversion\s*=\s*")[^"]*(")/, `$1${version}$2`);
}

/**
 * Stamp the napi version sentinel in the Rust source and committed generated
 * JS/TS binding surfaces. The sentinel `js_name = "__piNativesV{major}_{minor}_{patch}"`
 * is a guard that must track the package version: the `@sayknow-cli/natives`
 * test asserts it equals `package.json#version`, and the JS loader expects the
 * matching generated export. Upstream bumps it via `scripts/release.ts`; the
 * fork bumps it here so generated fork trees are release-version consistent.
 */
function stampNativeSentinel(text: string, version: string): string {
	const sentinel = `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
	return text.replace(/__piNativesV[A-Za-z0-9_]+/g, sentinel);
}

function main(): void {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const cfgIdx = args.indexOf("--config");
	const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--config");
	if (!target) {
		console.error("usage: bun scripts/apply-fork-identity.ts <target-dir> [--config <path>] [--apply]");
		process.exit(2);
	}
	const root = path.resolve(target);
	const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : path.join(root, "rebrand/identity.json");
	const id = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Identity;

	const edits: { file: string; before: string; after: string }[] = [];
	const queue = (file: string, after: string) => {
		const before = fs.readFileSync(file, "utf8");
		if (after !== before) edits.push({ file: path.relative(root, file), before, after });
	};

	// Root package.json: private (no top-level version), but its catalog pins the
	// workspace package versions — stamp those.
	const rootPkg = path.join(root, "package.json");
	if (fs.existsSync(rootPkg)) {
		queue(rootPkg, stampCatalog(stampPackageVersion(fs.readFileSync(rootPkg, "utf8"), id.version), id.version));
	}
	// Workspace member packages: stamp their own version.
	const pkgs: string[] = [];
	findPackageJsons(root, pkgs);
	for (const file of pkgs) {
		const text = fs.readFileSync(file, "utf8");
		const name = packageName(text);
		if (name !== undefined && PACKAGE_VERSION_EXCEPTIONS.has(name)) continue;
		queue(file, stampPackageVersion(text, id.version));
	}
	const cargo = path.join(root, "Cargo.toml");
	if (fs.existsSync(cargo)) {
		queue(cargo, stampCargoWorkspaceVersion(fs.readFileSync(cargo, "utf8"), id.version));
	}
	const nativeSentinelFiles = [
		path.join(root, "crates/pi-natives/src/lib.rs"),
		path.join(root, "packages/natives/native/index.d.ts"),
		path.join(root, "packages/natives/native/index.js"),
	];
	for (const file of nativeSentinelFiles) {
		if (fs.existsSync(file)) {
			queue(file, stampNativeSentinel(fs.readFileSync(file, "utf8"), id.version));
		}
	}

	console.log(`apply-fork-identity: version=${id.version}, ${edits.length} files to stamp`);
	if (!apply) {
		for (const e of edits) console.log(`  ${e.file}`);
		console.log("\nRe-run with --apply to write.");
		return;
	}
	for (const e of edits) fs.writeFileSync(path.join(root, e.file), e.after);
	console.log("apply-fork-identity: applied.");
}

main();
