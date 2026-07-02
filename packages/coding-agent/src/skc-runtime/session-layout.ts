/**
 * Pure path layout for session-scoped SKC workflow state.
 *
 * Every generated/runtime artifact for a SKC session lives under
 * `<cwd>/.skc/_session-{encodedSessionId}/...`. The `_session-` prefix is what
 * discriminates a session directory from shared, user-authored/installed config
 * (settings.json, secrets.yml, agents/, skc-plugins/, agent/, python-env/, user
 * skills/commands), which always stays at the `.skc/` root.
 *
 * This module is PURE and acyclic: every export is a deterministic function of
 * its arguments. It never reads `process.env` and never touches the filesystem.
 * Session resolution (flag/payload/env/latest-activity-marker) and any
 * filesystem scanning live in `session-resolution.ts`, the boundary module.
 */
import * as path from "node:path";

export const SKC_DIR = ".skc";
export const SKC_SESSION_PREFIX = "_session-";
export const SKC_SESSION_ACTIVITY_FILE = ".session-activity.json";

/** Source that produced a resolved SKC session id, for audit/diagnostics. */
export type SkcSessionSource = "flag" | "payload" | "env" | "latest";

export interface SkcSessionContext {
	skcSessionId: string;
	sessionRoot: string;
	source: SkcSessionSource;
}

/**
 * Encode a session id into a single safe path segment. Matches the historical
 * encoding used across the runtimes so ids round-trip identically:
 * `encodeURIComponent` plus dot-escaping (dots are legal in filenames but we
 * avoid `.`/`..` traversal ambiguity).
 */
export function encodeSessionSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

/** Inverse of {@link encodeSessionSegment}. */
export function decodeSessionSegment(segment: string): string {
	return decodeURIComponent(segment.replaceAll("%2E", "."));
}

/** Throw when a session id is missing or blank; never let blank suppress callers. */
export function assertNonEmptySkcSessionId(value: string | undefined, source: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`a non-empty SKC session id is required (${source})`);
	}
}

/**
 * Assert a value is safe to use as a single path segment: non-blank and free of
 * path separators or `.`/`..` traversal. Use for already-safe identifiers
 * (skill modes, slugs) where we want identical filenames but fail closed on
 * traversal rather than silently normalizing out of the intended directory.
 */
export function assertSafePathComponent(value: string, label: string): void {
	const trimmed = value.trim();
	if (trimmed === "") throw new Error(`${label} is required`);
	if (trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
		throw new Error(`${label} must be a safe path component (no separators or traversal): ${value}`);
	}
}

/** The shared `.skc/` root (holds shared config; never session-scoped). */
export function skcRoot(cwd: string): string {
	return path.join(cwd, SKC_DIR);
}

/** The per-session root directory: `<cwd>/.skc/_session-{encodedId}`. */
export function sessionRoot(cwd: string, skcSessionId: string): string {
	assertNonEmptySkcSessionId(skcSessionId, "sessionRoot");
	return path.join(skcRoot(cwd), `${SKC_SESSION_PREFIX}${encodeSessionSegment(skcSessionId)}`);
}

/** Directory name (no path) for a session id, e.g. `_session-abc`. */
export function sessionDirName(skcSessionId: string): string {
	assertNonEmptySkcSessionId(skcSessionId, "sessionDirName");
	return `${SKC_SESSION_PREFIX}${encodeSessionSegment(skcSessionId)}`;
}

/** Return the decoded session id for a `_session-*` directory name, else undefined. */
export function sessionIdFromDirName(name: string): string | undefined {
	if (!name.startsWith(SKC_SESSION_PREFIX)) return undefined;
	const suffix = name.slice(SKC_SESSION_PREFIX.length);
	if (suffix === "") return undefined;
	let decoded: string;
	try {
		decoded = decodeSessionSegment(suffix);
	} catch {
		return undefined;
	}
	return decoded.trim() === "" ? undefined : decoded;
}

/** Authoritative per-session activity marker path. */
export function sessionActivityPath(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), SKC_SESSION_ACTIVITY_FILE);
}

// ---- Top-level per-category subdir resolvers ----

export function sessionStateDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "state");
}
export function sessionSpecsDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "specs");
}
export function sessionPlansDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "plans");
}
export function sessionUltragoalDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "ultragoal");
}
export function sessionAuditDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "audit");
}
export function sessionReportsDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "reports");
}
export function sessionLogsDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "logs");
}
export function sessionRuntimeDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "runtime");
}
export function sessionRlmDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionRoot(cwd, skcSessionId), "rlm");
}

// ---- Nested resolvers under <sessionRoot>/state ----

export function activeStateDir(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "active");
}
export function activeSnapshotPath(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "skill-active-state.json");
}
export function activeEntryPath(cwd: string, skcSessionId: string, skill: string): string {
	const normalized = skill.trim();
	if (normalized === "") throw new Error("skill is required");
	return path.join(activeStateDir(cwd, skcSessionId), `${encodeSessionSegment(normalized)}.json`);
}
export function modeStatePath(cwd: string, skcSessionId: string, mode: string): string {
	const normalized = mode.trim();
	assertSafePathComponent(normalized, "mode");
	return path.join(sessionStateDir(cwd, skcSessionId), `${normalized}-state.json`);
}
export function auditPath(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "audit.jsonl");
}
export function transactionJournalPath(cwd: string, skcSessionId: string, mutationId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "transactions", `${encodeSessionSegment(mutationId)}.json`);
}
export function teamStateRoot(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "team");
}
export function workflowGatePath(cwd: string, skcSessionId: string, gateId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "workflow-gates", `${encodeSessionSegment(gateId)}.json`);
}
export function harnessStateRoot(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "harness");
}
export function coordinatorMcpStateRoot(cwd: string, skcSessionId: string): string {
	return path.join(sessionStateDir(cwd, skcSessionId), "coordinator-mcp");
}

// ---- Nested resolvers under other top-level categories ----

export function tmuxRuntimeSessionPath(cwd: string, skcSessionId: string, slug: string): string {
	const normalized = slug.trim();
	assertSafePathComponent(normalized, "slug");
	return path.join(sessionRuntimeDir(cwd, skcSessionId), "tmux-sessions", `${normalized}.json`);
}
export function rlmArtifactRoot(cwd: string, skcSessionId: string, rlmSessionId: string): string {
	const normalized = rlmSessionId.trim();
	if (normalized === "") throw new Error("rlmSessionId is required");
	return path.join(sessionRlmDir(cwd, skcSessionId), encodeSessionSegment(normalized));
}
