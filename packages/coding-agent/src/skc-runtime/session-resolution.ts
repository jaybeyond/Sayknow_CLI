/**
 * Boundary session resolution for SKC workflow state.
 *
 * This is the impure companion to the pure `session-layout.ts`. Only CLI /
 * runtime entrypoints call these resolvers; low-level readers and writers
 * receive an explicit `skcSessionId` (or a path produced by the pure helper) so
 * no module silently picks a session.
 *
 * Resolution order:
 *   1. explicit `--session-id` flag (blank is invalid, never suppressed)
 *   2. payload `session_id`
 *   3. `SKC_SESSION_ID` env var
 *   4. latest-activity-marker auto-detect (READ/STATUS/CLEAR only)
 *
 * Writes require one of (1)-(3). Auto-detect fails closed on zero candidates or
 * ambiguous ties.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	SKC_SESSION_ACTIVITY_FILE,
	type SkcSessionContext,
	type SkcSessionSource,
	sessionIdFromDirName,
	sessionRoot,
	skcRoot,
} from "./session-layout";

/** Window within which two activity timestamps are treated as an ambiguous tie. */
export const LATEST_SESSION_TIE_WINDOW_MS = 1000;

export interface SessionIdSources {
	/** Raw `--session-id` value: `undefined` = flag absent; `""` = present-but-blank (invalid). */
	flagValue?: string | undefined;
	payloadSessionId?: unknown;
	envSessionId?: string | undefined;
}

export class SessionResolutionError extends Error {
	constructor(
		message: string,
		readonly code: "blank_flag" | "no_session" | "ambiguous" | "missing_for_write",
	) {
		super(message);
		this.name = "SessionResolutionError";
	}
}

interface ResolvedFromSources {
	skcSessionId: string;
	source: SkcSessionSource;
}

/**
 * Resolve a session id from explicit sources only (flag -> payload -> env).
 * Returns `undefined` when none is present. A blank explicit flag throws.
 */
export function resolveSessionIdFromSources(sources: SessionIdSources): ResolvedFromSources | undefined {
	const { flagValue, payloadSessionId, envSessionId } = sources;
	if (flagValue !== undefined) {
		const trimmed = flagValue.trim();
		if (trimmed === "") {
			throw new SessionResolutionError(
				"--session-id was provided but blank; pass a non-empty session id or omit the flag",
				"blank_flag",
			);
		}
		return { skcSessionId: trimmed, source: "flag" };
	}
	if (typeof payloadSessionId === "string" && payloadSessionId.trim() !== "") {
		return { skcSessionId: payloadSessionId.trim(), source: "payload" };
	}
	if (typeof envSessionId === "string" && envSessionId.trim() !== "") {
		return { skcSessionId: envSessionId.trim(), source: "env" };
	}
	return undefined;
}

/** Resolve session context for a WRITE command. Errors when no explicit id is present. */
export function resolveSkcSessionForWrite(cwd: string, sources: SessionIdSources): SkcSessionContext {
	const resolved = resolveSessionIdFromSources(sources);
	if (!resolved) {
		throw new SessionResolutionError(
			"a session id is required to write state: pass --session-id, payload session_id, or set SKC_SESSION_ID",
			"missing_for_write",
		);
	}
	return {
		skcSessionId: resolved.skcSessionId,
		sessionRoot: sessionRoot(cwd, resolved.skcSessionId),
		source: resolved.source,
	};
}

/**
 * Resolve session context for a READ/STATUS/CLEAR command. Falls back to the
 * latest active session by activity marker when no explicit id is present.
 */
export async function resolveSkcSessionForRead(cwd: string, sources: SessionIdSources): Promise<SkcSessionContext> {
	const resolved = resolveSessionIdFromSources(sources);
	if (resolved) {
		return {
			skcSessionId: resolved.skcSessionId,
			sessionRoot: sessionRoot(cwd, resolved.skcSessionId),
			source: resolved.source,
		};
	}
	const latest = await detectLatestSession(cwd);
	return { skcSessionId: latest.skcSessionId, sessionRoot: latest.sessionRoot, source: "latest" };
}

interface SessionCandidate {
	skcSessionId: string;
	sessionRoot: string;
	activityMs: number;
}

/**
 * Scan `.skc/_session-*` directories and select the most-recently-active one by
 * its activity marker. Never uses raw directory mtime. Throws on zero candidates
 * or an ambiguous tie.
 */
export async function detectLatestSession(cwd: string): Promise<SkcSessionContext> {
	const candidates = await collectActiveSessionCandidates(cwd);
	if (candidates.length === 0) {
		throw new SessionResolutionError(
			"no active SKC session found: pass --session-id or set SKC_SESSION_ID",
			"no_session",
		);
	}
	candidates.sort((a, b) => b.activityMs - a.activityMs);
	const [first, second] = candidates;
	if (second && first.activityMs - second.activityMs <= LATEST_SESSION_TIE_WINDOW_MS) {
		const tied = candidates
			.filter(c => first.activityMs - c.activityMs <= LATEST_SESSION_TIE_WINDOW_MS)
			.map(c => c.skcSessionId);
		throw new SessionResolutionError(
			`ambiguous latest session among [${tied.join(", ")}]: pass --session-id or set SKC_SESSION_ID`,
			"ambiguous",
		);
	}
	return { skcSessionId: first.skcSessionId, sessionRoot: first.sessionRoot, source: "latest" };
}

async function collectActiveSessionCandidates(cwd: string): Promise<SessionCandidate[]> {
	const root = skcRoot(cwd);
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates: SessionCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skcSessionId = sessionIdFromDirName(entry.name);
		if (!skcSessionId) continue;
		const dir = path.join(root, entry.name);
		const activityMs = await readActivityMs(path.join(dir, SKC_SESSION_ACTIVITY_FILE));
		// Sessions with no readable activity marker are considered inactive and
		// are not selected for auto-detect.
		if (activityMs === undefined) continue;
		candidates.push({ skcSessionId, sessionRoot: dir, activityMs });
	}
	return candidates;
}

async function readActivityMs(markerPath: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(markerPath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { updated_at?: unknown };
		if (typeof parsed.updated_at === "string") {
			const ms = Date.parse(parsed.updated_at);
			if (!Number.isNaN(ms)) return ms;
		}
	} catch {
		// fall through to mtime
	}
	try {
		const stat = await fs.stat(markerPath);
		return stat.mtimeMs;
	} catch {
		return undefined;
	}
}

export interface ActivityMarkerInfo {
	writer: string;
	/** Relative generated path that was just written, for diagnostics. */
	path?: string;
}

/**
 * Best-effort write of the per-session activity marker. State-command callers
 * MUST treat a thrown error as a command failure (auto-detect depends on it);
 * non-critical writers may swallow it.
 */
export async function writeSessionActivityMarker(
	cwd: string,
	skcSessionId: string,
	info: ActivityMarkerInfo,
): Promise<void> {
	const markerPath = path.join(sessionRoot(cwd, skcSessionId), SKC_SESSION_ACTIVITY_FILE);
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	const payload = {
		session_id: skcSessionId,
		updated_at: new Date().toISOString(),
		writer: info.writer,
		...(info.path ? { path: info.path } : {}),
	};
	await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
