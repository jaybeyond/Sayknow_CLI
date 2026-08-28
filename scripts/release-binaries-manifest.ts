#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const BINARY_MANIFEST_FILE = "sayknow-release-binaries-v1.json";
export const BINARY_SHA256_FILE = "sayknow-release-binaries.sha256";
export const RELEASE_BINARY_NAMES = [
	"skc-linux-x64",
	"skc-linux-arm64",
	"skc-darwin-arm64",
	"skc-darwin-x64",
	"skc-windows-x64.exe",
] as const;

type ReleaseBinaryName = (typeof RELEASE_BINARY_NAMES)[number];

export interface ReleaseBinariesManifest {
	schema: "sayknow-release-binaries-v1";
	schema_version: 1;
	release_version: string;
	tag: string;
	binaries: Array<{ name: ReleaseBinaryName; sha256: string; size: number }>;
}

const RELEASE_TAG = /^sayknow-v(\d+\.\d+\.\d+)$/;

export function parseReleaseTag(tag: string): { tag: string; version: string } {
	const match = tag.match(RELEASE_TAG);
	if (!match) throw new Error(`Invalid Sayknow release tag: ${tag}`);
	return { tag, version: match[1]! };
}

export function sha256File(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function buildReleaseBinariesManifest(options: { binDir: string; tag: string }): ReleaseBinariesManifest {
	const release = parseReleaseTag(options.tag);
	const binaries: ReleaseBinariesManifest["binaries"] = [];
	for (const name of RELEASE_BINARY_NAMES) {
		const filePath = path.join(options.binDir, name);
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) throw new Error(`Release binary ${name} is empty or not a file`);
		binaries.push({ name, sha256: sha256File(filePath), size: stat.size });
	}
	return {
		schema: "sayknow-release-binaries-v1",
		schema_version: 1,
		release_version: release.version,
		tag: release.tag,
		binaries,
	};
}

export function formatSha256Sums(manifest: ReleaseBinariesManifest): string {
	return `${manifest.binaries.map(entry => `${entry.sha256}  ${entry.name}`).join("\n")}\n`;
}

export function writeReleaseBinariesManifest(options: {
	binDir: string;
	tag: string;
}): { manifestPath: string; sha256Path: string; manifest: ReleaseBinariesManifest } {
	const manifest = buildReleaseBinariesManifest(options);
	const manifestPath = path.join(options.binDir, BINARY_MANIFEST_FILE);
	const sha256Path = path.join(options.binDir, BINARY_SHA256_FILE);
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	fs.writeFileSync(sha256Path, formatSha256Sums(manifest));
	return { manifestPath, sha256Path, manifest };
}

export function parseSha256Sums(text: string, assetName: string): string | undefined {
	const matches: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})  [ *]?([^/\\]+)$/);
		if (match?.[2] === assetName) matches.push(match[1]!.toLowerCase());
	}
	if (matches.length > 1) throw new Error(`Checksum manifest lists ${assetName} more than once`);
	return matches[0];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const binDirIndex = args.indexOf("--bin-dir");
	const tagIndex = args.indexOf("--tag");
	if (binDirIndex < 0 || tagIndex < 0 || !args[binDirIndex + 1] || !args[tagIndex + 1]) {
		throw new Error("usage: bun scripts/release-binaries-manifest.ts --bin-dir <dir> --tag <sayknow-vX.Y.Z>");
	}
	const result = writeReleaseBinariesManifest({ binDir: args[binDirIndex + 1]!, tag: args[tagIndex + 1]! });
	process.stdout.write(`wrote ${result.manifestPath}\nwrote ${result.sha256Path}\n`);
}
