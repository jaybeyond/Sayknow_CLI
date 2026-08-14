// Live-system bindings for restore eligibility.
//
// `session-restore.ts` stays pure and injectable so its fail-closed decision
// table can be tested without a filesystem or a tmux server. This module is the
// thin adapter that supplies the real readings.

import * as fsSync from "node:fs";
import type { BootGeneration } from "./boot-generation";
import {
	type RestoreCandidateDeps,
	type RestorePointer,
	type RestoreSidecarFacts,
	readTranscriptSessionId,
} from "./session-restore";
import { SKC_COORDINATOR_SESSION_ID_ENV, SKC_COORDINATOR_SESSION_STATE_FILE_ENV } from "./session-state-sidecar";
import { resolveSkcTmuxBinary } from "./tmux-common";
import { createSkcTmuxSession, listSkcTmuxSessions } from "./tmux-sessions";

const TERMINAL_SIDECAR_STATES = new Set(["completed", "errored"]);

/**
 * Strict re-read of the sidecar a pointer names.
 *
 * Returns null for missing, unreadable, or malformed content: restore must never
 * infer a session's identity from the pointer alone.
 */
export function readSidecarFacts(pointer: RestorePointer): RestoreSidecarFacts | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fsSync.readFileSync(pointer.state_file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
	if (!sessionId) return null;
	return {
		sessionId,
		stateFile: pointer.state_file,
		sessionFile: typeof parsed.session_file === "string" ? parsed.session_file : null,
		cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
		terminal: typeof parsed.state === "string" && TERMINAL_SIDECAR_STATES.has(parsed.state),
	};
}

/**
 * True when a tmux session already carries this exact coordinator identity.
 *
 * An unreadable tmux is reported as a collision on purpose: not being able to
 * see the server is not evidence that the identity is free.
 */
export function hasLiveIdentity(pointer: RestorePointer, env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		return listSkcTmuxSessions(env).some(
			session =>
				session.sessionId === pointer.coordinator_session_id && session.sessionStateFile === pointer.state_file,
		);
	} catch {
		return true;
	}
}

/** psmux exposes no immutable native session identity, so restore cannot prove ownership there. */
export function ownerProofAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	try {
		return !resolveSkcTmuxBinary({ env }).isPsmux;
	} catch {
		return false;
	}
}

export function buildRestoreCandidateDeps(
	currentBoot: BootGeneration,
	env: NodeJS.ProcessEnv = process.env,
): RestoreCandidateDeps {
	return {
		currentBoot,
		readSidecar: readSidecarFacts,
		pathExists: target => fsSync.existsSync(target),
		hasLiveIdentity: pointer => hasLiveIdentity(pointer, env),
		readTranscriptSessionId: pointer => readTranscriptSessionId(pointer.session_file),
		ownerProofAvailable: () => ownerProofAvailable(env),
	};
}

export type RestoreOutcome =
	| { ok: true; pointer: RestorePointer; tmuxSession: string }
	| { ok: false; pointer: RestorePointer; code: string; detail: string };

/**
 * Restores exactly one eligible candidate.
 *
 * Deliberately goes through the ordinary fenced creator rather than spawning
 * tmux directly: restore must inherit the same identity fence, owner-isolation
 * proof, and exact cleanup as every other producer. The only differences are the
 * working directory and the `--resume` argv handed to the child.
 *
 * Never cleans up another owner's session. A fence refusal is reported and the
 * candidate is skipped.
 */
export function restoreSession(pointer: RestorePointer, env: NodeJS.ProcessEnv = process.env): RestoreOutcome {
	// The child must adopt the recorded identity, not this process's.
	const childEnv: NodeJS.ProcessEnv = {
		...env,
		[SKC_COORDINATOR_SESSION_ID_ENV]: pointer.coordinator_session_id,
		[SKC_COORDINATOR_SESSION_STATE_FILE_ENV]: pointer.state_file,
		SKC_SESSION_ID: pointer.skc_session_id,
	};
	try {
		const session = createSkcTmuxSession(childEnv, {
			cwd: pointer.cwd,
			childArgs: ["--resume", pointer.skc_session_id],
		});
		return { ok: true, pointer, tmuxSession: session.name };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const [code = "restore_failed"] = message.split(":");
		return { ok: false, pointer, code, detail: message };
	}
}
