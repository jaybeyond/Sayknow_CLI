import * as fs from "node:fs";
import * as path from "node:path";

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

/** Authority a discovery read runs under. */
export type ReadScope = "project" | "user";

export interface ReadFileOptions {
	readonly scope?: ReadScope;
	/** Skip the shared lexical cache for this operation. */
	readonly bypassCache?: boolean;
	/**
	 * Physical root a target lexically inside it must stay inside after
	 * realpath, so a repository symlink cannot be read as its external target.
	 */
	readonly containmentRoot?: string;
}

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

function isWithinOrEqual(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * A lexical path outside the boundary keeps the historical read. A path inside
 * the boundary must still be inside after realpath; otherwise it is unreadable.
 */
async function containedReadPath(abs: string, options?: ReadFileOptions): Promise<string | null> {
	const root = options?.containmentRoot;
	if (!root) return abs;
	const boundary = path.resolve(root);
	if (!isWithinOrEqual(boundary, abs)) return abs;
	try {
		const [boundaryReal, targetReal] = await Promise.all([fs.promises.realpath(boundary), fs.promises.realpath(abs)]);
		return isWithinOrEqual(boundaryReal, targetReal) ? targetReal : null;
	} catch {
		return null;
	}
}

export async function readFile(filePath: string, options?: ReadFileOptions): Promise<string | null> {
	const abs = resolvePath(filePath);
	// A contained read must not share the lexical cache with a different boundary.
	const useCache = !options?.bypassCache && !options?.containmentRoot;
	if (useCache && contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	const readable = await containedReadPath(abs, options);
	if (readable === null) {
		if (useCache) contentCache.set(abs, null);
		return null;
	}
	try {
		const content = await Bun.file(readable).text();
		if (useCache) contentCache.set(abs, content);
		return content;
	} catch {
		if (useCache) contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(
	dirPath: string,
	options?: Pick<ReadFileOptions, "bypassCache">,
): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	const useCache = !options?.bypassCache;
	if (useCache && dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		if (useCache) dirCache.set(abs, entries);
		return entries;
	} catch {
		if (useCache) dirCache.set(abs, []);
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Reads bypass the directory cache: the repository root is the project read
 * boundary, so a `.git` created after an earlier discovery must narrow it.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current, { bypassCache: true });
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
