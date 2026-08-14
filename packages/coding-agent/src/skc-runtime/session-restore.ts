// Discovery and eligibility for reboot-only session restore.
//
// Session sidecars live inside each project (under `<project>/.skc/_session-<id>/
// runtime/tmux-sessions/`), so there is no way to enumerate them globally — that
// is precisely why restore needs its own index. Each session publishes an
// immutable POINTER under SKC's own config root; the pointer is a candidate
// list, never authority. Every decision is re-derived from the sidecar, the
// transcript and live tmux at the moment of restore.
//
// Every branch here is fail-closed: an answer that is not provably "safe to
// restore" is never treated as one.

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@sayknow-cli/utils/dirs";
import {
	type BootComparison,
	type BootGeneration,
	compareBootGeneration,
	type RecordedBootGeneration,
	readBootGeneration,
	recordBootGeneration,
} from "./boot-generation";

export const RESTORE_POINTER_SCHEMA_VERSION = 1;

export interface RestorePointer {
	schema_version: number;
	/** Coordinator identity: what the create fence and the sidecar are keyed by. */
	coordinator_session_id: string;
	state_file: string;
	/** SKC session id whose transcript `skc --resume` would reopen. */
	skc_session_id: string;
	session_file: string;
	cwd: string;
	branch: string | null;
	boot: RecordedBootGeneration;
	updated_at: string;
}

/** Pointers live under SKC's own root so they are discoverable without scanning projects. */
export function restorePointerDirectory(): string {
	return path.join(getAgentDir(), "session-restore", "pointers");
}

export function restorePointerFile(coordinatorSessionId: string, stateFile: string): string {
	const digest = crypto.createHash("sha256").update(`${coordinatorSessionId}\u0000${stateFile}`).digest("hex");
	return path.join(restorePointerDirectory(), `${digest}.json`);
}

export function isRestorePointer(value: unknown): value is RestorePointer {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	const strings = ["coordinator_session_id", "state_file", "skc_session_id", "session_file", "cwd", "updated_at"];
	if (record.schema_version !== RESTORE_POINTER_SCHEMA_VERSION) return false;
	if (!strings.every(key => typeof record[key] === "string" && (record[key] as string).length > 0)) return false;
	if (record.branch !== null && typeof record.branch !== "string") return false;
	const boot = record.boot as Record<string, unknown> | undefined;
	return (
		typeof boot === "object" &&
		boot !== null &&
		typeof boot.source === "string" &&
		typeof boot.value === "string" &&
		boot.value.length > 0
	);
}

/**
 * The session id `skc --resume` resolves is the transcript header id, which is
 * NOT the coordinator id: a normal `skc --tmux` child inherits only the
 * coordinator identity and then mints its own session id. Reading it from the
 * transcript is the only way a pointer can name the conversation that will
 * actually be reopened.
 */
export function readTranscriptSessionId(sessionFile: string): string | null {
	let handle: number | undefined;
	try {
		handle = fsSync.openSync(sessionFile, "r");
		const buffer = Buffer.alloc(8192);
		const read = fsSync.readSync(handle, buffer, 0, buffer.length, 0);
		const firstLine = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
		if (!firstLine.trim()) return null;
		const parsed = JSON.parse(firstLine) as Record<string, unknown>;
		if (parsed.type !== "session") return null;
		const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
		return id.length > 0 ? id : null;
	} catch {
		return null;
	} finally {
		if (handle !== undefined) {
			try {
				fsSync.closeSync(handle);
			} catch {}
		}
	}
}

export interface PublishRestorePointerInput {
	coordinatorSessionId: string;
	stateFile: string;
	skcSessionId: string;
	sessionFile: string;
	cwd: string;
	branch?: string | null;
	bootGeneration?: BootGeneration;
	now?: () => Date;
}

/**
 * Publishes (or refreshes) the pointer for a live session.
 *
 * Returns false without writing when the platform cannot produce boot evidence:
 * a pointer whose boot value is unusable could never be judged `changed`, so
 * writing one would only add noise. Never throws — losing a pointer must not
 * break the session that was trying to publish it.
 */
export function publishRestorePointer(input: PublishRestorePointerInput): boolean {
	const boot = recordBootGeneration(input.bootGeneration ?? readBootGeneration());
	if (!boot) return false;
	const pointer: RestorePointer = {
		schema_version: RESTORE_POINTER_SCHEMA_VERSION,
		coordinator_session_id: input.coordinatorSessionId,
		state_file: input.stateFile,
		skc_session_id: input.skcSessionId,
		session_file: input.sessionFile,
		cwd: input.cwd,
		branch: input.branch ?? null,
		boot,
		updated_at: (input.now ?? (() => new Date()))().toISOString(),
	};
	const file = restorePointerFile(input.coordinatorSessionId, input.stateFile);
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	try {
		fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fsSync.writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
		fsSync.renameSync(temporary, file);
		return true;
	} catch {
		try {
			fsSync.unlinkSync(temporary);
		} catch {}
		return false;
	}
}

function readRestorePointer(file: string): RestorePointer | null {
	try {
		const parsed = JSON.parse(fsSync.readFileSync(file, "utf8")) as unknown;
		return isRestorePointer(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Lists candidate pointers. Unreadable or malformed entries are skipped, never guessed at. */
export function listRestorePointers(): RestorePointer[] {
	const directory = restorePointerDirectory();
	let names: string[];
	try {
		names = fsSync.readdirSync(directory);
	} catch {
		return [];
	}
	const pointers: RestorePointer[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(directory, name);
		// Only regular files inside the index count. A symlink here would let
		// anything outside the index be read as a restore candidate.
		try {
			if (!fsSync.lstatSync(file).isFile()) continue;
		} catch {
			continue;
		}
		const pointer = readRestorePointer(file);
		if (pointer) pointers.push(pointer);
	}
	return pointers;
}

/**
 * Exact reference to one candidate, for `skc session restore --reference`.
 *
 * base64url of the identity pair, so a reference cannot be confused with a
 * session id, a path, or a prefix. It selects a candidate; it never overrides
 * any eligibility check.
 */
export function encodeRestoreReference(coordinatorSessionId: string, stateFile: string): string {
	return Buffer.from(JSON.stringify([coordinatorSessionId, stateFile]), "utf8").toString("base64url");
}

export function decodeRestoreReference(reference: string): { coordinatorSessionId: string; stateFile: string } | null {
	if (!/^[A-Za-z0-9_-]+$/u.test(reference)) return null;
	try {
		const parsed = JSON.parse(Buffer.from(reference, "base64url").toString("utf8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 2) return null;
		const [coordinatorSessionId, stateFile] = parsed;
		if (typeof coordinatorSessionId !== "string" || typeof stateFile !== "string") return null;
		if (!coordinatorSessionId || !stateFile) return null;
		// Reject non-canonical encodings: several byte strings can decode to the
		// same pair, and a reference must name exactly one candidate.
		if (encodeRestoreReference(coordinatorSessionId, stateFile) !== reference) return null;
		return { coordinatorSessionId, stateFile };
	} catch {
		return null;
	}
}

export type RestoreIneligibleReason =
	| "same_boot"
	| "boot_unknown"
	| "sidecar_missing"
	| "sidecar_identity_mismatch"
	| "sidecar_terminal"
	| "transcript_missing"
	| "cwd_missing"
	| "live_identity_collision"
	| "transcript_identity_mismatch"
	| "unsupported_owner_proof";

export type RestoreCandidateVerdict =
	| { eligible: true; pointer: RestorePointer }
	| { eligible: false; pointer: RestorePointer; reason: RestoreIneligibleReason; detail?: string };

/** The sidecar fields restore is allowed to trust, read fresh at decision time. */
export interface RestoreSidecarFacts {
	sessionId: string;
	stateFile: string;
	sessionFile: string | null;
	cwd: string | null;
	terminal: boolean;
}

export interface RestoreCandidateDeps {
	currentBoot: BootGeneration;
	/** Strict re-read of the referenced sidecar. Null when absent or unparseable. */
	readSidecar: (pointer: RestorePointer) => RestoreSidecarFacts | null;
	pathExists: (target: string) => boolean;
	/** True when a live tmux session already owns this identity. */
	hasLiveIdentity: (pointer: RestorePointer) => boolean;
	/** Header id of the transcript the pointer names, re-read at decision time. */
	readTranscriptSessionId: (pointer: RestorePointer) => string | null;
	/** False when this host cannot produce the owner proof restore requires (psmux). */
	ownerProofAvailable: () => boolean;
}

/**
 * Decides whether one candidate may be restored.
 *
 * Order matters: the reboot proof comes first because it is the cheapest and the
 * most restrictive gate, and the pointer's own contents are never trusted beyond
 * naming what to re-read.
 */
export function evaluateRestoreCandidate(pointer: RestorePointer, deps: RestoreCandidateDeps): RestoreCandidateVerdict {
	const boot: BootComparison = compareBootGeneration(pointer.boot, deps.currentBoot);
	if (boot !== "changed") {
		return { eligible: false, pointer, reason: boot === "same_boot" ? "same_boot" : "boot_unknown" };
	}

	if (!deps.ownerProofAvailable()) return { eligible: false, pointer, reason: "unsupported_owner_proof" };

	const sidecar = deps.readSidecar(pointer);
	if (!sidecar) return { eligible: false, pointer, reason: "sidecar_missing" };
	// The pointer is a hint; the sidecar is authority. They must agree exactly.
	if (
		sidecar.sessionId !== pointer.coordinator_session_id ||
		sidecar.stateFile !== pointer.state_file ||
		// A sidecar that records no transcript cannot corroborate the pointer's
		// claim, and a stale pointer would then select somebody else's transcript.
		sidecar.sessionFile === null ||
		sidecar.sessionFile !== pointer.session_file
	) {
		return { eligible: false, pointer, reason: "sidecar_identity_mismatch" };
	}
	if (sidecar.terminal) return { eligible: false, pointer, reason: "sidecar_terminal" };

	if (!deps.pathExists(pointer.session_file)) return { eligible: false, pointer, reason: "transcript_missing" };
	if (!deps.pathExists(pointer.cwd)) return { eligible: false, pointer, reason: "cwd_missing" };
	// `--resume` resolves the transcript header id, so a pointer whose recorded id
	// no longer matches would reopen the wrong conversation — or none at all.
	if (deps.readTranscriptSessionId(pointer) !== pointer.skc_session_id) {
		return { eligible: false, pointer, reason: "transcript_identity_mismatch" };
	}
	// A live owner means this identity never died; restoring would be a duplicate.
	if (deps.hasLiveIdentity(pointer)) return { eligible: false, pointer, reason: "live_identity_collision" };

	return { eligible: true, pointer };
}

export function evaluateRestoreCandidates(
	pointers: readonly RestorePointer[],
	deps: RestoreCandidateDeps,
): RestoreCandidateVerdict[] {
	return pointers.map(pointer => evaluateRestoreCandidate(pointer, deps));
}
