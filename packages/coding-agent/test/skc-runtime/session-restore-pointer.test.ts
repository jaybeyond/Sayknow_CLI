import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@sayknow-cli/utils/dirs";
import type { BootGeneration } from "../../src/skc-runtime/boot-generation";
import {
	evaluateRestoreCandidates,
	listRestorePointers,
	publishRestorePointer,
	type RestoreCandidateDeps,
	readTranscriptSessionId,
	restorePointerDirectory,
	restorePointerFile,
} from "../../src/skc-runtime/session-restore";
import {
	buildRestoreCandidateDeps,
	readSidecarFacts,
	restoreSession,
} from "../../src/skc-runtime/session-restore-runtime";
import {
	__setOwnerIncarnationReaderForTests,
	releaseIdentityCreate,
	reserveIdentityCreate,
} from "../../src/skc-runtime/tmux-owner-isolation";
import { __setCreateOwnerIsolationForTests } from "../../src/skc-runtime/tmux-sessions";

const originalAgentDir = process.env.SKC_CODING_AGENT_DIR;
const roots: string[] = [];

const RECORDED: BootGeneration = { source: "darwin-kern-boottime", value: "1.000001" };
const REBOOTED: BootGeneration = { source: "darwin-kern-boottime", value: "2.000002" };

function isolatedRoot(): { agentDir: string; project: string } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skc-restore-pointer-")));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	setAgentDir(agentDir);
	const project = path.join(root, "project");
	fs.mkdirSync(project, { recursive: true });
	return { agentDir, project };
}

function writeSidecar(project: string, sessionId: string, over: Record<string, unknown> = {}): string {
	const stateFile = path.join(project, ".skc", `_session-${sessionId}`, "runtime", "state.json");
	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	const transcript = path.join(project, "transcript.jsonl");
	// A real transcript begins with its session header; the resume id lives there.
	fs.writeFileSync(
		transcript,
		`${JSON.stringify({ type: "session", version: 5, id: `skc-${sessionId}`, cwd: project })}\n`,
	);
	fs.writeFileSync(
		stateFile,
		`${JSON.stringify({ session_id: sessionId, state: "running", cwd: project, session_file: transcript, ...over })}\n`,
	);
	return stateFile;
}

function deps(currentBoot: BootGeneration): RestoreCandidateDeps {
	return {
		currentBoot,
		readSidecar: readSidecarFacts,
		pathExists: (target: string) => fs.existsSync(target),
		hasLiveIdentity: () => false,
		ownerProofAvailable: () => true,
		readTranscriptSessionId: p => readTranscriptSessionId(p.session_file),
	};
}

afterEach(() => {
	if (originalAgentDir) setAgentDir(originalAgentDir);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("restore pointer index", () => {
	it("makes a project-local sidecar globally discoverable", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");

		// The whole reason the index exists: nothing outside the project could find
		// this sidecar by scanning.
		expect(listRestorePointers()).toEqual([]);
		expect(
			publishRestorePointer({
				coordinatorSessionId: "coord-a",
				stateFile,
				skcSessionId: "skc-a",
				sessionFile: path.join(project, "transcript.jsonl"),
				cwd: project,
				bootGeneration: RECORDED,
			}),
		).toBe(true);

		const pointers = listRestorePointers();
		expect(pointers).toHaveLength(1);
		expect(pointers[0]?.coordinator_session_id).toBe("coord-a");
		expect(pointers[0]?.state_file).toBe(stateFile);
		expect(restorePointerFile("coord-a", stateFile).startsWith(restorePointerDirectory())).toBe(true);
	});

	it("republishing the same identity refreshes rather than duplicates", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		const publish = (value: string) =>
			publishRestorePointer({
				coordinatorSessionId: "coord-a",
				stateFile,
				skcSessionId: "skc-a",
				sessionFile: path.join(project, "transcript.jsonl"),
				cwd: project,
				bootGeneration: { source: "darwin-kern-boottime", value },
			});
		expect(publish("1.000001")).toBe(true);
		expect(publish("3.000003")).toBe(true);
		const pointers = listRestorePointers();
		expect(pointers).toHaveLength(1);
		expect(pointers[0]?.boot.value).toBe("3.000003");
	});

	it("refuses to publish when the host has no usable boot evidence", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		expect(
			publishRestorePointer({
				coordinatorSessionId: "coord-a",
				stateFile,
				skcSessionId: "skc-a",
				sessionFile: path.join(project, "transcript.jsonl"),
				cwd: project,
				bootGeneration: { source: "unavailable", value: null },
			}),
		).toBe(false);
		expect(listRestorePointers()).toEqual([]);
	});

	it("skips unreadable and malformed index entries instead of guessing", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		publishRestorePointer({
			coordinatorSessionId: "coord-a",
			stateFile,
			skcSessionId: "skc-a",
			sessionFile: path.join(project, "transcript.jsonl"),
			cwd: project,
			bootGeneration: RECORDED,
		});
		fs.writeFileSync(path.join(restorePointerDirectory(), "garbage.json"), "{ not json");
		fs.writeFileSync(
			path.join(restorePointerDirectory(), "wrong-schema.json"),
			JSON.stringify({ schema_version: 9 }),
		);
		fs.writeFileSync(path.join(restorePointerDirectory(), "ignored.txt"), "irrelevant");

		expect(listRestorePointers()).toHaveLength(1);
	});
});

describe("restore evaluation against real files", () => {
	function publishFor(project: string, sessionId: string, over: Record<string, unknown> = {}): void {
		const stateFile = writeSidecar(project, sessionId, over);
		publishRestorePointer({
			coordinatorSessionId: sessionId,
			stateFile,
			skcSessionId: `skc-${sessionId}`,
			sessionFile: path.join(project, "transcript.jsonl"),
			cwd: project,
			bootGeneration: RECORDED,
		});
	}

	it("is restorable only after a proven reboot", () => {
		const { project } = isolatedRoot();
		publishFor(project, "coord-a");

		// Same boot: the session may still be alive.
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(RECORDED))[0]).toMatchObject({
			eligible: false,
			reason: "same_boot",
		});
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0]).toMatchObject({ eligible: true });
	});

	it("drops a candidate whose sidecar finished, was deleted, or drifted", () => {
		const { project } = isolatedRoot();

		publishFor(project, "coord-done", { state: "completed" });
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0]).toMatchObject({
			eligible: false,
			reason: "sidecar_terminal",
		});

		const drifted = isolatedRoot();
		publishFor(drifted.project, "coord-drift");
		const pointer = listRestorePointers()[0];
		if (!pointer) throw new Error("expected a pointer");
		fs.writeFileSync(
			pointer.state_file,
			`${JSON.stringify({ session_id: "somebody-else", state: "running", cwd: drifted.project })}\n`,
		);
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0]).toMatchObject({
			eligible: false,
			reason: "sidecar_identity_mismatch",
		});

		const removed = isolatedRoot();
		publishFor(removed.project, "coord-gone");
		const gone = listRestorePointers()[0];
		if (!gone) throw new Error("expected a pointer");
		fs.rmSync(gone.state_file);
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0]).toMatchObject({
			eligible: false,
			reason: "sidecar_missing",
		});
	});

	it("drops a candidate whose transcript no longer exists", () => {
		const { project } = isolatedRoot();
		publishFor(project, "coord-a");
		fs.rmSync(path.join(project, "transcript.jsonl"));
		expect(evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0]).toMatchObject({
			eligible: false,
			reason: "transcript_missing",
		});
	});
});

describe("dry run mutates nothing", () => {
	it("leaves the index and every referenced file byte-identical", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		publishRestorePointer({
			coordinatorSessionId: "coord-a",
			stateFile,
			skcSessionId: "skc-a",
			sessionFile: path.join(project, "transcript.jsonl"),
			cwd: project,
			bootGeneration: RECORDED,
		});

		const snapshot = (target: string) => {
			const stat = fs.statSync(target);
			return { bytes: fs.readFileSync(target).toString("hex"), ino: stat.ino, mtimeMs: stat.mtimeMs };
		};
		const pointerPath = restorePointerFile("coord-a", stateFile);
		const before = {
			pointer: snapshot(pointerPath),
			sidecar: snapshot(stateFile),
			index: fs.readdirSync(restorePointerDirectory()).sort(),
			agentTree: fs.readdirSync(getAgentDir()).sort(),
		};

		// The evaluation pass is exactly what `--dry-run` performs.
		evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED));

		expect(snapshot(pointerPath)).toEqual(before.pointer);
		expect(snapshot(stateFile)).toEqual(before.sidecar);
		expect(fs.readdirSync(restorePointerDirectory()).sort()).toEqual(before.index);
		// No lock file, no attempt database, no quarantine directory appeared.
		expect(fs.readdirSync(getAgentDir()).sort()).toEqual(before.agentTree);
	});
});

describe("restoreSession", () => {
	it("adopts the recorded identity and resumes that transcript in its own cwd", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		publishRestorePointer({
			coordinatorSessionId: "coord-a",
			stateFile,
			skcSessionId: "skc-a",
			sessionFile: path.join(project, "transcript.jsonl"),
			cwd: project,
			bootGeneration: RECORDED,
		});
		const pointer = listRestorePointers()[0];
		if (!pointer) throw new Error("expected a pointer");

		// Stop inside the owner-isolation plan so nothing is actually spawned, and
		// inspect the argv the fenced creator was about to run.
		let plannedArgv: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (plan.ok) plannedArgv = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		try {
			const outcome = restoreSession(pointer, {
				SKC_PSMUX_DETECTION: "off",
				SKC_TMUX_COMMAND: "tmux",
				SKC_TMUX_SESSION: "restored-session",
			});
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			// Restore goes through the ordinary fenced creator, so it fails the same
			// way an ordinary create would rather than inventing its own path.
			expect(outcome.detail).toContain("scope_bootstrap_failed");

			const inner = plannedArgv?.at(-1) ?? "";
			// The child resumes the recorded transcript, from the recorded directory,
			// under the recorded coordinator identity.
			expect(inner).toContain("skc '--resume' 'skc-a'");
			expect(inner).toContain(`cd '${project}'`);
			expect(inner).toContain("SKC_COORDINATOR_SESSION_ID='coord-a'");
			expect(inner).toContain(`SKC_COORDINATOR_SESSION_STATE_FILE='${stateFile}'`);
		} finally {
			__setCreateOwnerIsolationForTests(null);
		}
	});

	it("reports a fence refusal instead of touching another owner's session", () => {
		const { project } = isolatedRoot();
		const stateFile = writeSidecar(project, "coord-a");
		publishRestorePointer({
			coordinatorSessionId: "coord-a",
			stateFile,
			skcSessionId: "skc-a",
			sessionFile: path.join(project, "transcript.jsonl"),
			cwd: project,
			bootGeneration: RECORDED,
		});
		const pointer = listRestorePointers()[0];
		if (!pointer) throw new Error("expected a pointer");

		__setOwnerIncarnationReaderForTests(() => "darwin:1700000000:707070");
		const held = reserveIdentityCreate(
			{ stateDir: path.dirname(stateFile), sessionId: "coord-a", stateFile },
			{ ownerPid: process.pid, ownerIncarnation: "darwin:1700000000:707070" },
		);
		expect(held.ok).toBe(true);
		if (!held.ok) return;

		let spawnAttempts = 0;
		__setCreateOwnerIsolationForTests({
			execute: () => {
				spawnAttempts += 1;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "must-not-reach" };
			},
		});
		try {
			const outcome = restoreSession(pointer, {
				SKC_PSMUX_DETECTION: "off",
				SKC_TMUX_COMMAND: "tmux",
				SKC_TMUX_SESSION: "restored-session",
			});
			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.code).toBe("skc_tmux_identity_create_identity_reserved_live");
			// Nothing was spawned, tagged, or killed.
			expect(spawnAttempts).toBe(0);
		} finally {
			__setCreateOwnerIsolationForTests(null);
			__setOwnerIncarnationReaderForTests(null);
			releaseIdentityCreate(held.reservation);
		}
	});
});

describe("resume identity comes from the transcript, not the coordinator", () => {
	// A normal `skc --tmux` child inherits only the coordinator identity and then
	// mints its own session id. If the pointer recorded the coordinator id, the
	// restored child would run `skc --resume <wrong id>` and reopen nothing — the
	// exact break that makes reboot recovery useless for the default launch path.
	function writeTranscript(dir: string, headerId: string): string {
		const file = path.join(dir, `2026-08-04T00-00-00-000Z_${headerId}.jsonl`);
		fs.writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 5, id: headerId, cwd: dir })}\n${JSON.stringify({ type: "model_change", id: "abc" })}\n`,
		);
		return file;
	}

	it("reads the header id out of a real transcript", () => {
		const { project } = isolatedRoot();
		const file = writeTranscript(project, "019fcc0d-7fdf-7000-880d-01ff7e92ee3c");
		expect(readTranscriptSessionId(file)).toBe("019fcc0d-7fdf-7000-880d-01ff7e92ee3c");
		// Anything that is not a session header is refused rather than guessed.
		fs.writeFileSync(path.join(project, "not-a-transcript.jsonl"), '{"type":"model_change","id":"x"}\n');
		expect(readTranscriptSessionId(path.join(project, "not-a-transcript.jsonl"))).toBeNull();
		expect(readTranscriptSessionId(path.join(project, "missing.jsonl"))).toBeNull();
	});

	it("refuses a pointer whose recorded id no longer matches its transcript", () => {
		const { project } = isolatedRoot();
		const headerId = "019fcc0d-7fdf-7000-880d-01ff7e92ee3c";
		const transcript = writeTranscript(project, headerId);
		const stateFile = path.join(project, ".skc", "_session-coord-x", "runtime", "state.json");
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		fs.writeFileSync(
			stateFile,
			`${JSON.stringify({ session_id: "coord-x", state: "running", cwd: project, session_file: transcript })}\n`,
		);
		// The coordinator id is deliberately used as the resume id here: that is the
		// old, broken shape.
		publishRestorePointer({
			coordinatorSessionId: "coord-x",
			stateFile,
			skcSessionId: "coord-x",
			sessionFile: transcript,
			cwd: project,
			bootGeneration: RECORDED,
		});
		const verdict = evaluateRestoreCandidates(listRestorePointers(), deps(REBOOTED))[0];
		expect(verdict).toMatchObject({ eligible: false, reason: "transcript_identity_mismatch" });
	});

	it("restores the transcript's own conversation for a default tmux child", () => {
		const { project } = isolatedRoot();
		const headerId = "019fcc0d-7fdf-7000-880d-01ff7e92ee3c";
		const transcript = writeTranscript(project, headerId);
		const stateFile = path.join(project, ".skc", "_session-coord-x", "runtime", "state.json");
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		fs.writeFileSync(
			stateFile,
			`${JSON.stringify({ session_id: "coord-x", state: "running", cwd: project, session_file: transcript })}\n`,
		);
		publishRestorePointer({
			coordinatorSessionId: "coord-x",
			stateFile,
			// Derived the way the sidecar hook now derives it.
			skcSessionId: readTranscriptSessionId(transcript) ?? "",
			sessionFile: transcript,
			cwd: project,
			bootGeneration: RECORDED,
		});
		const pointer = listRestorePointers()[0];
		if (!pointer) throw new Error("expected a pointer");
		expect(pointer.skc_session_id).toBe(headerId);
		expect(evaluateRestoreCandidates([pointer], deps(REBOOTED))[0]).toMatchObject({ eligible: true });

		// And the child actually resumes that id.
		let plannedArgv: string[] | undefined;
		__setCreateOwnerIsolationForTests({
			execute: plan => {
				if (plan.ok) plannedArgv = plan.execution.argv;
				return { ok: false, code: "scope_bootstrap_failed", diagnostic: "test-stop" };
			},
		});
		try {
			restoreSession(pointer, {
				SKC_PSMUX_DETECTION: "off",
				SKC_TMUX_COMMAND: "tmux",
				SKC_TMUX_SESSION: "restored-session",
			});
			expect(plannedArgv?.at(-1) ?? "").toContain(`skc '--resume' '${headerId}'`);
		} finally {
			__setCreateOwnerIsolationForTests(null);
		}
	});

	it("buildRestoreCandidateDeps wires the live transcript check", () => {
		const { project } = isolatedRoot();
		const transcript = writeTranscript(project, "019fcc0d-7fdf-7000-880d-01ff7e92ee3c");
		const built = buildRestoreCandidateDeps(REBOOTED, { SKC_PSMUX_DETECTION: "off" });
		expect(
			built.readTranscriptSessionId({ session_file: transcript } as unknown as Parameters<
				typeof built.readTranscriptSessionId
			>[0]),
		).toBe("019fcc0d-7fdf-7000-880d-01ff7e92ee3c");
	});
});
