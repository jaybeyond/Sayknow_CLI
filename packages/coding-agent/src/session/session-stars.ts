/**
 * Starred sessions: discovery-only metadata kept in one small index file under
 * the agent directory, keyed by session id.
 *
 * Stars never touch transcripts. They sort sessions first in the resume picker
 * and the sessions dashboard, and nothing else: `--continue`, ID-prefix
 * resolution, deletion, and retention ignore them. A deleted session leaves a
 * harmless stale id behind; a forked session gets a new id and starts unstarred.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@sayknow-cli/utils";
import { withFileLock } from "../config/file-lock";

const INDEX_FILE_NAME = "session-stars.json";

interface StarIndexFile {
	version: 1;
	/** Session id → ISO time the star was added. */
	starred: Record<string, string>;
}

let cache: { path: string; mtimeMs: number; size: number; ids: ReadonlySet<string> } | undefined;

export function getSessionStarIndexPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, INDEX_FILE_NAME);
}

function parseIndex(text: string): StarIndexFile {
	const parsed = JSON.parse(text) as Partial<StarIndexFile>;
	const starred: Record<string, string> = {};
	if (parsed && typeof parsed === "object" && parsed.starred && typeof parsed.starred === "object") {
		for (const [id, at] of Object.entries(parsed.starred)) {
			if (typeof at === "string") starred[id] = at;
		}
	}
	return { version: 1, starred };
}

/**
 * Ids of starred sessions. Cheap to call per listed session: the parsed index is
 * cached until the file's mtime or size changes. A missing or unreadable index
 * means nothing is starred; listing never fails because of stars.
 */
export function readStarredSessionIds(agentDir?: string): ReadonlySet<string> {
	const indexPath = getSessionStarIndexPath(agentDir);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(indexPath);
	} catch {
		cache = undefined;
		return new Set();
	}
	if (cache?.path === indexPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.ids;
	try {
		const ids = new Set(Object.keys(parseIndex(fs.readFileSync(indexPath, "utf8")).starred));
		cache = { path: indexPath, mtimeMs: stat.mtimeMs, size: stat.size, ids };
		return ids;
	} catch (error) {
		logger.warn("Ignoring unreadable session star index", { indexPath, error: String(error) });
		return new Set();
	}
}

export function isSessionIdStarred(sessionId: string, agentDir?: string): boolean {
	return readStarredSessionIds(agentDir).has(sessionId);
}

/**
 * Star or unstar a session by id. Returns `true` when the index changed and
 * `false` when the session was already in the requested state. The
 * read-modify-write runs under a cross-process lock and lands with an atomic
 * rename, so two CLIs toggling different sessions cannot drop each other's star.
 */
export async function setSessionIdStarred(sessionId: string, starred: boolean, agentDir?: string): Promise<boolean> {
	if (!sessionId) throw new Error("A session id is required to change its star.");
	const indexPath = getSessionStarIndexPath(agentDir);
	await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
	return withFileLock(indexPath, async () => {
		let index: StarIndexFile;
		try {
			index = parseIndex(await fs.promises.readFile(indexPath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				// Refuse to overwrite an index we cannot read: that would silently drop every other star.
				throw new Error(`Cannot update session stars: ${indexPath} is unreadable (${String(error)}).`);
			}
			index = { version: 1, starred: {} };
		}
		if (sessionId in index.starred === starred) return false;
		if (starred) index.starred[sessionId] = new Date().toISOString();
		else delete index.starred[sessionId];
		const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.promises.writeFile(tmpPath, `${JSON.stringify(index, null, "\t")}\n`, "utf8");
			await fs.promises.rename(tmpPath, indexPath);
		} catch (error) {
			await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
			throw error;
		}
		cache = undefined;
		return true;
	});
}
