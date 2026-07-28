/**
 * fork-version-neutral.ts — remove release-version text from files before they are
 * diffed into `rebrand/patches`.
 *
 * Why this exists: `apply-fork-identity.ts` owns the fork version and stamps it into
 * package.json versions, the root catalog pins, the Cargo workspace version, and the
 * napi sentinel. If a patch is extracted from a tree carrying a concrete version, that
 * version leaks into the diff — not only as a changed line but as *context* lines
 * around unrelated hunks. The next sync stamps a different version, the context no
 * longer matches, and `git apply` rejects an otherwise clean patch. That is a
 * guaranteed conflict on every release bump.
 *
 * So both sides neutralize first: extraction diffs neutralized text, and gen-tree
 * neutralizes the generated tree before applying patches. The placeholders are chosen
 * to be re-stamped by the very same apply-fork-identity regexes afterwards.
 */
import * as path from "node:path";

export const NEUTRAL_VERSION = "0.0.0-forkver";
export const NEUTRAL_SENTINEL = "__piNativesVFORKVER";

/**
 * Workspace packages that keep their own version instead of the fork release version.
 * apply-fork-identity skips them, so neutralization must skip them too — otherwise the
 * placeholder is baked into a patch and never stamped back.
 */
export const PACKAGE_VERSION_EXCEPTIONS = new Set([
	"@sayknow-cli/orchestration-token-benchmark",
	"@sayknow-cli/typescript-edit-benchmark",
]);

/** First `"name"` field of a package.json. */
export function packageName(text: string): string | undefined {
	return /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

/** Files whose napi sentinel apply-fork-identity keeps in sync with the version. */
export const SENTINEL_FILES = [
	"crates/pi-natives/src/lib.rs",
	"packages/natives/native/index.d.ts",
	"packages/natives/native/index.js",
];

/** True when `rel` carries version text that apply-fork-identity owns. */
export function isVersionBearing(rel: string): boolean {
	const norm = rel.split(path.sep).join("/");
	return path.basename(norm) === "package.json" || norm === "Cargo.toml" || SENTINEL_FILES.includes(norm);
}

/**
 * Replace every version token apply-fork-identity would stamp with a stable
 * placeholder. Non version-bearing files are returned untouched.
 */
export function neutralizeVersions(rel: string, text: string): string {
	const norm = rel.split(path.sep).join("/");
	let out = text;
	if (path.basename(norm) === "package.json") {
		const name = packageName(text);
		// Top-level "version" (first occurrence, package.json convention).
		if (name === undefined || !PACKAGE_VERSION_EXCEPTIONS.has(name)) {
			out = out.replace(/("version"\s*:\s*")[^"]*(")/, `$1${NEUTRAL_VERSION}$2`);
		}
	}
	if (norm === "package.json") {
		// Only the ROOT package.json carries concrete catalog pins. Workspace members
		// reference them as "catalog:", which is not a version and must survive intact.
		out = out.replace(/("@sayknow-cli\/[A-Za-z0-9-]+"\s*:\s*")(?!catalog:)[^"]*(")/g, `$1${NEUTRAL_VERSION}$2`);
	}
	if (norm === "Cargo.toml") {
		out = out.replace(/(\[workspace\.package\][\s\S]*?\bversion\s*=\s*")[^"]*(")/, `$1${NEUTRAL_VERSION}$2`);
	}
	if (SENTINEL_FILES.includes(norm)) {
		out = out.replace(/__piNativesV[A-Za-z0-9_]+/g, NEUTRAL_SENTINEL);
	}
	return out;
}
