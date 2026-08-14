import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BootGeneration } from "../../src/skc-runtime/boot-generation";
import {
	decodeRestoreReference,
	encodeRestoreReference,
	evaluateRestoreCandidate,
	isRestorePointer,
	RESTORE_POINTER_SCHEMA_VERSION,
	type RestoreCandidateDeps,
	type RestorePointer,
} from "../../src/skc-runtime/session-restore";

const RECORDED_BOOT = { schema_version: 1, source: "darwin-kern-boottime", value: "1.000001" };
const CURRENT_BOOT: BootGeneration = { source: "darwin-kern-boottime", value: "2.000002" };

function pointer(over: Partial<RestorePointer> = {}): RestorePointer {
	return {
		schema_version: RESTORE_POINTER_SCHEMA_VERSION,
		coordinator_session_id: "coord-1",
		state_file: "/proj/.skc/_session-coord-1/runtime/tmux-sessions/s.json",
		skc_session_id: "019fac84-56e1-7000-85d2-aab6674afa76",
		session_file: "/home/u/.skc/agent/sessions/v2-x/2026_019fac84.jsonl",
		cwd: "/proj",
		branch: null,
		boot: RECORDED_BOOT,
		updated_at: "2026-07-29T00:00:00.000Z",
		...over,
	};
}

function deps(over: Partial<RestoreCandidateDeps> = {}): RestoreCandidateDeps {
	return {
		currentBoot: CURRENT_BOOT,
		readSidecar: p => ({
			sessionId: p.coordinator_session_id,
			stateFile: p.state_file,
			sessionFile: p.session_file,
			cwd: p.cwd,
			terminal: false,
		}),
		pathExists: () => true,
		hasLiveIdentity: () => false,
		ownerProofAvailable: () => true,
		readTranscriptSessionId: p => p.skc_session_id,
		...over,
	};
}

describe("restore pointer schema", () => {
	it("accepts a well-formed pointer and rejects every malformed shape", () => {
		expect(isRestorePointer(pointer())).toBe(true);
		expect(isRestorePointer(null)).toBe(false);
		expect(isRestorePointer({})).toBe(false);
		expect(isRestorePointer({ ...pointer(), schema_version: 2 })).toBe(false);
		expect(isRestorePointer({ ...pointer(), coordinator_session_id: "" })).toBe(false);
		expect(isRestorePointer({ ...pointer(), cwd: 42 })).toBe(false);
		expect(isRestorePointer({ ...pointer(), boot: { source: "darwin-kern-boottime" } })).toBe(false);
		// A branch is optional but must be a string when present.
		expect(isRestorePointer({ ...pointer(), branch: "main" })).toBe(true);
		expect(isRestorePointer({ ...pointer(), branch: 7 })).toBe(false);
	});
});

describe("restore reference codec", () => {
	it("round-trips the exact identity pair", () => {
		const reference = encodeRestoreReference("coord-1", "/proj/state.json");
		expect(decodeRestoreReference(reference)).toEqual({
			coordinatorSessionId: "coord-1",
			stateFile: "/proj/state.json",
		});
	});

	it("cannot be confused with a session id, a path, or a prefix", () => {
		expect(decodeRestoreReference("coord-1")).toBeNull();
		expect(decodeRestoreReference("/proj/state.json")).toBeNull();
		expect(decodeRestoreReference("")).toBeNull();
		// Valid base64url that decodes to the wrong shape is still refused.
		expect(decodeRestoreReference(Buffer.from('"hi"', "utf8").toString("base64url"))).toBeNull();
		expect(decodeRestoreReference(Buffer.from("[1,2]", "utf8").toString("base64url"))).toBeNull();
		expect(decodeRestoreReference(Buffer.from('["a"]', "utf8").toString("base64url"))).toBeNull();
		expect(decodeRestoreReference(Buffer.from('["a",""]', "utf8").toString("base64url"))).toBeNull();
	});
});

describe("evaluateRestoreCandidate", () => {
	it("is eligible only when every gate passes", () => {
		expect(evaluateRestoreCandidate(pointer(), deps())).toEqual({ eligible: true, pointer: pointer() });
	});

	it("refuses without a proven reboot, and checks that first", () => {
		// Same boot: the session may still be alive; restoring is a duplicate.
		const same = evaluateRestoreCandidate(pointer(), deps({ currentBoot: { ...CURRENT_BOOT, value: "1.000001" } }));
		expect(same).toMatchObject({ eligible: false, reason: "same_boot" });

		// Unreadable probe proves nothing.
		const unknown = evaluateRestoreCandidate(
			pointer(),
			deps({ currentBoot: { source: "unavailable", value: null } }),
		);
		expect(unknown).toMatchObject({ eligible: false, reason: "boot_unknown" });

		// A source change is never a reboot.
		const crossSource = evaluateRestoreCandidate(
			pointer({
				boot: { schema_version: 1, source: "linux-boot-id", value: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
			}),
			deps({ currentBoot: { source: "linux-proc-btime", value: "1700000000" } }),
		);
		expect(crossSource).toMatchObject({ eligible: false, reason: "boot_unknown" });
	});

	it("refuses before touching anything when this host cannot prove ownership", () => {
		let sidecarReads = 0;
		const verdict = evaluateRestoreCandidate(
			pointer(),
			deps({
				ownerProofAvailable: () => false,
				readSidecar: p => {
					sidecarReads += 1;
					return {
						sessionId: p.coordinator_session_id,
						stateFile: p.state_file,
						sessionFile: null,
						cwd: null,
						terminal: false,
					};
				},
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "unsupported_owner_proof" });
		expect(sidecarReads).toBe(0);
	});

	it("treats the sidecar as authority and the pointer as a hint", () => {
		expect(evaluateRestoreCandidate(pointer(), deps({ readSidecar: () => null }))).toMatchObject({
			eligible: false,
			reason: "sidecar_missing",
		});

		for (const drift of [
			{ sessionId: "somebody-else" },
			{ stateFile: "/other/state.json" },
			{ sessionFile: "/other/transcript.jsonl" },
		]) {
			const verdict = evaluateRestoreCandidate(
				pointer(),
				deps({
					readSidecar: p => ({
						sessionId: p.coordinator_session_id,
						stateFile: p.state_file,
						sessionFile: p.session_file,
						cwd: p.cwd,
						terminal: false,
						...drift,
					}),
				}),
			);
			expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_identity_mismatch" });
		}
	});

	it("never restores a session that already finished", () => {
		const verdict = evaluateRestoreCandidate(
			pointer(),
			deps({
				readSidecar: p => ({
					sessionId: p.coordinator_session_id,
					stateFile: p.state_file,
					sessionFile: p.session_file,
					cwd: p.cwd,
					terminal: true,
				}),
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_terminal" });
	});

	it("requires the transcript and the recorded cwd to still exist", () => {
		const noTranscript = evaluateRestoreCandidate(
			pointer(),
			deps({ pathExists: target => target !== "/home/u/.skc/agent/sessions/v2-x/2026_019fac84.jsonl" }),
		);
		expect(noTranscript).toMatchObject({ eligible: false, reason: "transcript_missing" });

		const noCwd = evaluateRestoreCandidate(pointer(), deps({ pathExists: target => target !== "/proj" }));
		expect(noCwd).toMatchObject({ eligible: false, reason: "cwd_missing" });
	});

	it("refuses when the transcript no longer carries the recorded session id", () => {
		// `--resume` resolves the transcript header id, so a pointer that names a
		// different id would reopen the wrong conversation or none at all.
		const verdict = evaluateRestoreCandidate(pointer(), deps({ readTranscriptSessionId: () => "somebody-else" }));
		expect(verdict).toMatchObject({ eligible: false, reason: "transcript_identity_mismatch" });

		const unreadable = evaluateRestoreCandidate(pointer(), deps({ readTranscriptSessionId: () => null }));
		expect(unreadable).toMatchObject({ eligible: false, reason: "transcript_identity_mismatch" });
	});

	it("refuses when a live owner already holds the identity", () => {
		const verdict = evaluateRestoreCandidate(pointer(), deps({ hasLiveIdentity: () => true }));
		expect(verdict).toMatchObject({ eligible: false, reason: "live_identity_collision" });
	});

	it("refuses a sidecar that does not record its transcript", () => {
		// Red-team finding: tolerating an absent transcript let a stale pointer
		// select a DIFFERENT existing transcript, because nothing corroborated the
		// pointer's claim. Unverifiable is a mismatch, not a tolerance.
		const verdict = evaluateRestoreCandidate(
			pointer(),
			deps({
				readSidecar: p => ({
					sessionId: p.coordinator_session_id,
					stateFile: p.state_file,
					sessionFile: null,
					cwd: p.cwd,
					terminal: false,
				}),
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_identity_mismatch" });
	});
});

describe("restore never uses the pathname lock primitive", () => {
	it("no restore module imports withFileLock", () => {
		// The approved contract replaced pathname-based locking with SQLite
		// transaction lifetime precisely because `withFileLock` deletes its lock
		// path and has a documented read-to-unlink window. A regression here would
		// silently reintroduce that race.
		const root = path.resolve(import.meta.dir, "../../src/skc-runtime");
		for (const file of ["session-restore.ts", "session-restore-runtime.ts", "boot-generation.ts"]) {
			const source = fs.readFileSync(path.join(root, file), "utf8");
			expect(source).not.toContain("withFileLock");
			expect(source).not.toContain("config/file-lock");
		}
	});
});
