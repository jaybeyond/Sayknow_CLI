#!/usr/bin/env bun

/**
 * Checks spoofed external tool versions against their latest upstream releases.
 *
 * We impersonate several external tools (Gemini CLI, Claude Code) via User-Agent
 * strings. When these tools release new versions, the upstream service may start
 * rejecting or deprioritizing older versions. This script detects drift so we
 * can bump before users hit 400s/403s/429s.
 *
 * This is not hypothetical for Claude Code: Anthropic gates newer models on the
 * advertised client version and answers HTTP 400 `claude_code_version_too_old`.
 * It has bitten twice — 2.1.219 was under the 2.1.251 gate of the 5.1 line, and
 * 2.1.267 was under the 2.1.280 gate of `claude-opus-5-5`, which made a model
 * that was bundled, listed and preset-selectable fail on every request.
 *
 * Usage:
 *   bun scripts/check-spoofed-versions.ts          # check and report
 *   bun scripts/check-spoofed-versions.ts --update  # update source in-place
 */

import * as path from "node:path";

const repoFile = (relativePath: string): string => path.join(import.meta.dir, "..", relativePath);

interface VersionCheck {
	/** Human label for the report. */
	name: string;
	/** Source file holding the hardcoded version. */
	file: string;
	/** Regex to extract the current hardcoded version from `file`. */
	sourcePattern: RegExp;
	/** Resolve the newest version published upstream. */
	fetchLatest: () => Promise<string | null>;
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

/** Fetch latest non-prerelease tag from a GitHub repo. */
async function fetchLatestGitHubRelease(repo: string, parseTag: (tag: string) => string | null): Promise<string | null> {
	try {
		// /releases/latest only returns non-prerelease, non-draft releases
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "sayknow-cli/version-check" },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? parseTag(data.tag_name) : null;
	} catch {
		return null;
	}
}

/**
 * Fetch a dist-tag from the npm registry. Claude Code ships to npm rather than
 * GitHub releases, and `latest` is the version Anthropic's own gate messages
 * tell users to update to.
 */
async function fetchLatestNpmVersion(packageName: string, distTag: string): Promise<string | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${packageName}`, {
			headers: { Accept: "application/json", "User-Agent": "sayknow-cli/version-check" },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { "dist-tags"?: Record<string, string> };
		const version = data["dist-tags"]?.[distTag];
		return version ? (SEMVER_RE.exec(version)?.[1] ?? null) : null;
	} catch {
		return null;
	}
}

const checks: VersionCheck[] = [
	{
		name: "Gemini CLI",
		file: repoFile("packages/ai/src/providers/google-gemini-headers.ts"),
		// Matches the constant, not the env-override expression it feeds: the
		// inline `PI_AI_GEMINI_CLI_VERSION || "x.y.z"` shape this used to target
		// was refactored away, and the check silently degraded to a [WARN].
		sourcePattern: /export const DEFAULT_GEMINI_CLI_VERSION = "(\d+\.\d+\.\d+)"/,
		fetchLatest: () =>
			fetchLatestGitHubRelease("google-gemini/gemini-cli", tag => SEMVER_RE.exec(tag)?.[1] ?? null),
	},
	{
		name: "Claude Code",
		file: repoFile("packages/ai/src/providers/anthropic.ts"),
		sourcePattern: /export const claudeCodeVersion = "(\d+\.\d+\.\d+)"/,
		fetchLatest: () => fetchLatestNpmVersion("@anthropic-ai/claude-code", "latest"),
	},
];

async function run() {
	const doUpdate = process.argv.includes("--update");
	const sources = new Map<string, string>();
	const updatedFiles = new Set<string>();
	let anyDrift = false;
	let anyChecked = false;

	for (const check of checks) {
		let source = sources.get(check.file);
		if (source === undefined) {
			source = await Bun.file(check.file).text();
			sources.set(check.file, source);
		}

		const match = check.sourcePattern.exec(source);
		if (!match?.[1]) {
			console.error(`[WARN] Could not extract current ${check.name} version from source`);
			continue;
		}

		const current = match[1];
		const latest = await check.fetchLatest();

		if (!latest) {
			console.error(`[FAIL] Could not fetch latest ${check.name} version`);
			continue;
		}

		anyChecked = true;

		if (current === latest) {
			console.log(`[OK]   ${check.name}: ${current} (up to date)`);
		} else {
			console.log(`[DRIFT] ${check.name}: ${current} -> ${latest}`);
			anyDrift = true;

			if (doUpdate) {
				sources.set(check.file, source.replace(match[0], match[0].replace(current, latest)));
				updatedFiles.add(check.file);
				console.log(`       Updated in source.`);
			}
		}
	}

	for (const file of updatedFiles) {
		await Bun.write(file, sources.get(file) ?? "");
		console.log(`\nWrote updates to ${path.relative(process.cwd(), file)}`);
	}

	if (!anyChecked) {
		console.error("\nNo version checks succeeded. Cannot verify freshness.");
		process.exit(1);
	}

	if (anyDrift && !doUpdate) {
		console.log("\nRun with --update to apply version bumps.");
		process.exit(1);
	}
}

run();
