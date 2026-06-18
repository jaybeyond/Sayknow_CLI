import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getAgentDir, pathIsWithin } from "@sayknow-cli/utils";
import { SKC_PLUGIN_MANIFEST_FILENAME, SkcPluginLoadError } from "./types";

export function skcPluginUserRoot(): string {
	return path.join(getAgentDir(), "skc-plugins");
}

export function skcPluginProjectRoot(cwd: string): string {
	return path.join(cwd, ".skc", "skc-plugins");
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function rootContainsSkcManifest(dir: string): Promise<boolean> {
	try {
		await fs.access(path.join(dir, SKC_PLUGIN_MANIFEST_FILENAME));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function discoverSkcPluginRootsIn(baseDir: string): Promise<string[]> {
	if (await rootContainsSkcManifest(baseDir)) return [baseDir];

	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(baseDir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const roots = await Promise.all(
		entries
			.filter(entry => entry.isDirectory() || entry.isSymbolicLink())
			.map(async entry => {
				const dir = path.join(baseDir, entry.name);
				return (await rootContainsSkcManifest(dir)) ? dir : null;
			}),
	);

	return roots.filter((root): root is string => root !== null);
}

export async function discoverSkcPluginRoots({ cwd }: { cwd: string; home?: string }): Promise<string[]> {
	const roots = await Promise.all([
		discoverSkcPluginRootsIn(skcPluginUserRoot()),
		discoverSkcPluginRootsIn(skcPluginProjectRoot(cwd)),
	]);
	return roots.flat();
}

export function resolveWithinRoot(root: string, rel: string): string {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, rel);
	if (!pathIsWithin(resolvedRoot, resolvedPath)) {
		throw new SkcPluginLoadError("missing_file", `SKC plugin path escapes root: ${rel}`);
	}
	return resolvedPath;
}
