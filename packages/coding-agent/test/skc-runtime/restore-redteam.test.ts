import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@sayknow-cli/utils/dirs";
import SessionCommand from "../../src/commands/session";
import {
	type BootGeneration,
	compareBootGeneration,
	isRecordedBootGeneration,
	parseDarwinBootTime,
	parseLinuxProcBtime,
	readBootGeneration,
} from "../../src/skc-runtime/boot-generation";
import {
	decodeRestoreReference,
	encodeRestoreReference,
	evaluateRestoreCandidate,
	listRestorePointers,
	RESTORE_POINTER_SCHEMA_VERSION,
	type RestoreCandidateDeps,
	type RestorePointer,
	restorePointerDirectory,
} from "../../src/skc-runtime/session-restore";
import { readSidecarFacts } from "../../src/skc-runtime/session-restore-runtime";
import {
	__setOwnerIncarnationReaderForTests,
	advanceIdentityCreatePhase,
	canonicalIdentityCreateKey,
	type IdentityCreateKey,
	reclaimIdentityCreate,
	reserveIdentityCreate,
} from "../../src/skc-runtime/tmux-owner-isolation";

const OWNER_INCARNATION = "redteam-incarnation";
const ORIGINAL_AGENT_DIR = getAgentDir();
const ORIGINAL_AGENT_DIR_ENV = process.env.SKC_CODING_AGENT_DIR;

let root: string;
let agentDir: string;

function pointer(over: Partial<RestorePointer> = {}): RestorePointer {
	return {
		schema_version: RESTORE_POINTER_SCHEMA_VERSION,
		coordinator_session_id: "coord-redteam",
		state_file: path.join(root, "project", "state.json"),
		skc_session_id: "skc-redteam",
		session_file: path.join(root, "project", "transcript.jsonl"),
		cwd: path.join(root, "project"),
		branch: null,
		boot: { schema_version: 1, source: "darwin-kern-boottime", value: "1.000001" },
		updated_at: "2026-08-04T00:00:00.000Z",
		...over,
	};
}

function candidateDeps(over: Partial<RestoreCandidateDeps> = {}): RestoreCandidateDeps {
	return {
		currentBoot: { source: "darwin-kern-boottime", value: "2.000002" },
		readSidecar: current => ({
			sessionId: current.coordinator_session_id,
			stateFile: current.state_file,
			sessionFile: current.session_file,
			cwd: current.cwd,
			terminal: false,
		}),
		pathExists: () => true,
		hasLiveIdentity: () => false,
		ownerProofAvailable: () => true,
		readTranscriptSessionId: current => current.skc_session_id,
		...over,
	};
}

function key(sessionId = "coord-redteam"): IdentityCreateKey {
	const stateDir = path.join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	const stateFile = path.join(stateDir, `${sessionId}.json`);
	writeFileSync(stateFile, "{}\n");
	return { stateDir, sessionId, stateFile };
}

function writePointer(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function snapshotTree(directory: string): string[] {
	if (!existsSync(directory)) return [];
	const entries: string[] = [];
	const visit = (current: string): void => {
		const stat = lstatSync(current);
		const relative = path.relative(directory, current) || ".";
		entries.push(`${relative}\tino=${stat.ino}\tsize=${stat.size}\tmode=${stat.mode}`);
		if (!stat.isDirectory()) return;
		for (const name of readdirSync(current).sort()) visit(path.join(current, name));
	};
	visit(directory);
	return entries;
}

async function runSessionCommand(argv: string[]): Promise<string> {
	let output = "";
	const write = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	});
	try {
		const command = new SessionCommand(argv, { bin: "skc", version: "0.0.0-test", commands: new Map() });
		await command.run();
		return output;
	} finally {
		write.mockRestore();
	}
}
type SpawnSyncRecorder = {
	calls: string[][];
	restore: () => void;
};

function recordSyncSpawns(): SpawnSyncRecorder {
	const calls: string[][] = [];
	const actual = Bun.spawnSync.bind(Bun) as unknown as (...args: unknown[]) => unknown;
	const spy = spyOn(Bun, "spawnSync") as unknown as {
		mockImplementation: (implementation: (input: unknown, ...args: unknown[]) => unknown) => void;
		mockRestore: () => void;
	};
	spy.mockImplementation((input, ...args) => {
		const argv = Array.isArray(input) ? input : ((input as { cmd?: string[] }).cmd ?? []);
		calls.push(argv);
		if (argv[0] === "tmux") throw new Error("redteam dry-run invoked tmux");
		return actual(input, ...args);
	});
	return { calls, restore: () => spy.mockRestore() };
}

function changedCurrentBoot(): RestorePointer["boot"] {
	const current = readBootGeneration();
	if (current.source === "unavailable" || !current.value)
		return { schema_version: 1, source: "unavailable", value: "unavailable" };
	return { schema_version: 1, source: current.source, value: `${current.value}-redteam` };
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "skc-restore-redteam-"));
	agentDir = path.join(root, "agent");
	setAgentDir(agentDir);
	__setOwnerIncarnationReaderForTests(() => OWNER_INCARNATION);
});

afterEach(() => {
	__setOwnerIncarnationReaderForTests(null);
	setAgentDir(ORIGINAL_AGENT_DIR);
	if (ORIGINAL_AGENT_DIR_ENV === undefined) delete process.env.SKC_CODING_AGENT_DIR;
	else process.env.SKC_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR_ENV;
	rmSync(root, { recursive: true, force: true });
});

describe("session restore red team", () => {
	it("rejects schema-version, empty-value, and numeric boot-record forgeries", () => {
		// Attack: coerce a malformed persisted record into changed. Result: these shapes are boot_unknown, so no spawn gate opens.
		const current: BootGeneration = { source: "darwin-kern-boottime", value: "2.000002" };
		for (const forged of [
			{ schema_version: 2, source: current.source, value: "1.000001" },
			{ schema_version: 1, source: current.source, value: "" },
			{ schema_version: 1, source: current.source, value: 1 },
		]) {
			expect(isRecordedBootGeneration(forged)).toBe(false);
			expect(compareBootGeneration(forged, current)).toBe("boot_unknown");
		}
	});

	it("refuses whitespace and Unicode boot values that would forge a reboot", () => {
		// Attack: edit a same-boot pointer's value to a non-empty junk string. Result: FOUND — schema validation accepts it and changed is executable.
		const current: BootGeneration = { source: "darwin-kern-boottime", value: "2.000002" };
		for (const value of [" ", "\u200b", "💥"]) {
			const forged: RestorePointer["boot"] = { schema_version: 1, source: current.source, value };
			expect(isRecordedBootGeneration(forged)).toBe(false);
			expect(compareBootGeneration(forged, current)).toBe("boot_unknown");
			expect(evaluateRestoreCandidate(pointer({ boot: forged }), candidateDeps())).toMatchObject({
				eligible: false,
				reason: "boot_unknown",
			});
		}
	});

	it("rejects a boot-source spoof even when its value differs", () => {
		// Attack: claim a Linux record was Darwin evidence. Result: source mismatch is boot_unknown rather than changed.
		expect(
			compareBootGeneration(
				{ schema_version: 1, source: "linux-proc-btime", value: "1" },
				{ source: "darwin-kern-boottime", value: "2.000002" },
			),
		).toBe("boot_unknown");
	});

	it("normalizes short Darwin usec fields without confusing distinct boot times", () => {
		// Attack: exploit usec width. Result: 7 and 000007 normalize to the same instant, while 700000 remains distinct.
		expect(parseDarwinBootTime("{ sec = 100, usec = 7 }")).toBe("100.000007");
		expect(parseDarwinBootTime("{ sec = 100, usec = 000007 }")).toBe("100.000007");
		expect(parseDarwinBootTime("{ sec = 100, usec = 700000 }")).toBe("100.700000");
	});

	it("refuses an impossible seven-digit usec field", () => {
		// Attack: feed usec >= 1,000,000. Result: FOUND parser accepts 100.1000000 instead of rejecting ambiguous malformed evidence.
		expect(parseDarwinBootTime("{ sec = 100, usec = 1000000 }")).toBeNull();
	});

	it("refuses a /proc/stat carrying duplicate btime records", () => {
		// Attack: make /proc/stat ambiguous with two btime lines. Result: FOUND parser selects the first instead of failing closed.
		expect(parseLinuxProcBtime("cpu 1 2 3\nbtime 101\nbtime 100\n")).toBeNull();
	});

	it("keeps a traversal-shaped reference opaque rather than treating it as a CLI path", () => {
		// Attack: embed ../ in the tuple. Result: decoding preserves it only as an identity string; the CLI later requires an exact pointer match.
		const reference = encodeRestoreReference("coord-redteam", "../../other-project/state.json");
		expect(decodeRestoreReference(reference)).toEqual({
			coordinatorSessionId: "coord-redteam",
			stateFile: "../../other-project/state.json",
		});
	});

	it("rejects nested arrays, objects, and invalid base64url references", () => {
		// Attack: supply JSON shapes that could confuse tuple destructuring. Result: only exactly two non-empty strings are accepted.
		for (const raw of [
			Buffer.from('[["coord"],"state"]', "utf8").toString("base64url"),
			Buffer.from('{"coordinatorSessionId":"coord","stateFile":"state"}', "utf8").toString("base64url"),
			Buffer.from('["coord",null]', "utf8").toString("base64url"),
			"%%%",
		]) {
			expect(decodeRestoreReference(raw)).toBeNull();
		}
	});

	it("fails closed on a null-byte state file when the runtime reads the sidecar", () => {
		// Attack: put a NUL in an otherwise valid decoded string. Result: Node rejects the filesystem read and runtime returns sidecar_missing.
		const nulState = "state\u0000.json";
		const decoded = decodeRestoreReference(encodeRestoreReference("coord-redteam", nulState));
		expect(decoded?.stateFile).toBe(nulState);
		const verdict = evaluateRestoreCandidate(
			pointer({ state_file: nulState }),
			candidateDeps({ readSidecar: readSidecarFacts }),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_missing" });
	});

	it("refuses non-canonical base64url spellings of a reference", () => {
		// Attack: alter ignored low bits in the final base64url character. Result: FOUND decode accepts a non-canonical spelling, though it selects the same pair.
		const canonical = encodeRestoreReference("coord-redteam", "/state.json");
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const alternate = [...alphabet]
			.map(last => `${canonical.slice(0, -1)}${last}`)
			.find(
				value =>
					value !== canonical &&
					JSON.stringify(decodeRestoreReference(value)) === JSON.stringify(decodeRestoreReference(canonical)),
			);
		// After the canonicality check no alternate spelling decodes at all, so the
		// search finds nothing. That absence is the guarantee.
		expect(alternate).toBeUndefined();
	});

	it("records that a large valid reference is decoded rather than bounded", () => {
		// Attack: send a 256 KiB tuple through the parser. Result: it is accepted; command-line argument limits bound CLI delivery, not this codec API.
		const largeState = `/${"a".repeat(256 * 1024)}`;
		const decoded = decodeRestoreReference(encodeRestoreReference("coord-redteam", largeState));
		expect(decoded?.stateFile).toHaveLength(largeState.length);
	});

	it("skips corrupt, huge, and permission-denied pointer files without throwing", () => {
		// Attack: poison index entries so discovery crashes or accepts them. Result: malformed entries are skipped and list remains available.
		const directory = restorePointerDirectory();
		mkdirSync(directory, { recursive: true });
		writeFileSync(path.join(directory, "corrupt.json"), "{");
		writeFileSync(path.join(directory, "huge.json"), "x".repeat(512 * 1024));
		const unreadable = path.join(directory, "unreadable.json");
		writeFileSync(unreadable, JSON.stringify(pointer()));
		chmodSync(unreadable, 0o000);
		try {
			expect(() => listRestorePointers()).not.toThrow();
			expect(listRestorePointers()).toEqual([]);
		} finally {
			chmodSync(unreadable, 0o600);
		}
	});

	it("refuses a pointer symlink during discovery", () => {
		// Attack: make the index point outside its directory. Result: the symlink is
		// skipped, so nothing outside the index can be read as a candidate.
		const external = path.join(root, "external-pointer.json");
		writePointer(external, pointer());
		const directory = restorePointerDirectory();
		mkdirSync(directory, { recursive: true });
		const linked = path.join(directory, "linked.json");
		symlinkSync(external, linked);
		expect(lstatSync(linked).isSymbolicLink()).toBe(true);
		expect(listRestorePointers()).toEqual([]);
	});

	it("rejects a pointer state-file swap to another session's sidecar", () => {
		// Attack: retarget coord A's pointer to coord B's sidecar. Result: sidecar session identity disagrees and no restore is eligible.
		const swapped = pointer({ state_file: path.join(root, "other", "state.json") });
		const verdict = evaluateRestoreCandidate(
			swapped,
			candidateDeps({
				readSidecar: current => ({
					sessionId: "coord-other",
					stateFile: current.state_file,
					sessionFile: current.session_file,
					cwd: current.cwd,
					terminal: false,
				}),
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_identity_mismatch" });
	});

	it("refuses a null sidecar sessionFile instead of trusting the pointer transcript", () => {
		// Attack: delete session_file from the authority sidecar and point the index at another existing transcript. Result: FOUND candidate stays eligible.
		const verdict = evaluateRestoreCandidate(
			pointer({ session_file: path.join(root, "other-session.jsonl") }),
			candidateDeps({
				readSidecar: current => ({
					sessionId: current.coordinator_session_id,
					stateFile: current.state_file,
					sessionFile: null,
					cwd: current.cwd,
					terminal: false,
				}),
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "sidecar_identity_mismatch" });
	});

	it("does not split an identity through relative, dot, or dot-dot aliases", () => {
		// Attack: reserve the same file through lexical aliases. Result: canonicalization collapses aliases and the second reservation is refused.
		const original = key();
		const first = reserveIdentityCreate(original);
		expect(first.ok).toBe(true);
		const alias: IdentityCreateKey = {
			stateDir: path.join(original.stateDir, ".", "nested", ".."),
			sessionId: original.sessionId,
			stateFile: path.join(original.stateDir, ".", "nested", "..", path.basename(original.stateFile)),
		};
		const contender = reserveIdentityCreate(alias);
		expect(contender).toMatchObject({ ok: false, code: "identity_reserved_live" });
	});

	it("does not split an identity through a state-directory symlink", () => {
		// Attack: use a symlinked state directory to obtain a second SQLite row. Result: realpath canonicalization reaches the existing reservation.
		const original = key();
		const link = path.join(root, "state-link");
		symlinkSync(original.stateDir, link);
		const first = reserveIdentityCreate(original);
		expect(first.ok).toBe(true);
		const contender = reserveIdentityCreate({
			stateDir: link,
			sessionId: original.sessionId,
			stateFile: path.join(link, path.basename(original.stateFile)),
		});
		expect(contender).toMatchObject({ ok: false, code: "identity_reserved_live" });
	});

	it("does not split a case-only alias when the filesystem resolves it to the same path", () => {
		// Attack: vary path case. Result: on a case-insensitive volume realpath unifies it; on a case-sensitive volume it is correctly a distinct path.
		const stateDir = path.join(root, "CaseState");
		mkdirSync(stateDir);
		const stateFile = path.join(stateDir, "coord-redteam.json");
		writeFileSync(stateFile, "{}\n");
		const aliasDir = path.join(root, "casestate");
		const original = { stateDir, sessionId: "coord-redteam", stateFile };
		if (!existsSync(aliasDir)) {
			expect(
				canonicalIdentityCreateKey({
					...original,
					stateDir: aliasDir,
					stateFile: path.join(aliasDir, "coord-redteam.json"),
				}).stateDir,
			).not.toBe(canonicalIdentityCreateKey(original).stateDir);
			return;
		}
		expect(reserveIdentityCreate(original).ok).toBe(true);
		expect(
			reserveIdentityCreate({
				...original,
				stateDir: aliasDir,
				stateFile: path.join(aliasDir, "coord-redteam.json"),
			}),
		).toMatchObject({ ok: false, code: "identity_reserved_live" });
	});

	it("fails closed when a directly tampered reservation impersonates a live owner", () => {
		// Attack: edit SQLite owner fields to trick liveness. Result: a live-looking row blocks the contender instead of permitting a second create.
		const identity = key();
		const first = reserveIdentityCreate(identity, { ownerPid: 424242, ownerIncarnation: "old-owner" });
		expect(first.ok).toBe(true);
		const db = new Database(path.join(agentDir, "identity-create-fence.sqlite"));
		try {
			db.query("UPDATE identity_create_reservation SET owner_pid = ?, owner_incarnation = ?").run(
				process.pid,
				OWNER_INCARNATION,
			);
		} finally {
			db.close();
		}
		const contender = reserveIdentityCreate(identity, { ownerPid: process.pid, ownerIncarnation: "contender" });
		expect(contender).toMatchObject({ ok: false, code: "identity_reserved_live" });
	});

	it("does not continue after an old reservation loses its phase advance", () => {
		// Attack: recover the row between phase transitions, then use the displaced reservation. Result: advance returns null and source call sites turn it into fenceLost().
		const identity = key();
		const first = reserveIdentityCreate(identity, { ownerPid: 424242, ownerIncarnation: "old-owner" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const replacement = reclaimIdentityCreate(identity, first.reservation.reservationId, {
			ownerPid: process.pid,
			ownerIncarnation: OWNER_INCARNATION,
			probeLiveness: () => "dead",
		});
		expect(replacement.ok).toBe(true);
		expect(
			advanceIdentityCreatePhase(first.reservation, "helper_invoked", { attemptSessionName: "must-not-spawn" }),
		).toBeNull();
		const creator = readFileSync(new URL("../../src/skc-runtime/tmux-sessions.ts", import.meta.url), "utf8");
		expect(creator).toContain(
			'advanceIdentityCreatePhase(reservation, "helper_invoked", { attemptSessionName: sessionName }) ??',
		);
		expect(creator).toContain('advanceIdentityCreatePhase(reservation, "spawned", {');
		expect(creator).toContain("}) ?? fenceLost()");
	});

	it("allows at most one simultaneous process to reserve the same canonical identity", async () => {
		// Attack: race two real Bun processes against the same SQLite row. Result: while the winner remains alive, exactly one receives ok.
		const identity = key();
		const ready = path.join(root, "winner-ready");
		const moduleUrl = new URL("../../src/skc-runtime/tmux-owner-isolation.ts", import.meta.url).href;
		const worker = (readyFile?: string) => {
			const script = [
				`import { __setOwnerIncarnationReaderForTests, reserveIdentityCreate } from ${JSON.stringify(moduleUrl)};`,
				'__setOwnerIncarnationReaderForTests(() => "redteam-worker");',
				`const result = reserveIdentityCreate(${JSON.stringify(identity)});`,
				readyFile ? `if (result.ok) await Bun.write(${JSON.stringify(readyFile)}, "ready");` : "",
				"console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.code }));",
				readyFile ? "await Bun.sleep(500);" : "",
			].join("\n");
			return Bun.spawn([process.execPath, "--eval", script], {
				cwd: process.cwd(),
				env: { ...process.env, SKC_CODING_AGENT_DIR: agentDir },
				stdout: "pipe",
				stderr: "pipe",
			});
		};
		const winner = worker(ready);
		for (let attempt = 0; attempt < 50 && !existsSync(ready); attempt += 1) await Bun.sleep(10);
		expect(existsSync(ready)).toBe(true);
		const contender = worker();
		await Promise.all([winner.exited, contender.exited]);
		const winnerResult = JSON.parse(await new Response(winner.stdout).text()) as { ok: boolean };
		const contenderResult = JSON.parse(await new Response(contender.stdout).text()) as {
			ok: boolean;
			code: string | null;
		};
		expect(winnerResult.ok).toBe(true);
		expect(contenderResult).toEqual({ ok: false, code: "identity_reserved_live" });
	});

	it("keeps dry-run immutable when the pointer index is corrupt", async () => {
		// Attack: make discovery throw before normal reporting. Result: command reports read-only output and inode/byte snapshot is unchanged.
		writePointer(path.join(restorePointerDirectory(), "corrupt.json"), "{");
		const before = snapshotTree(agentDir);
		const spawns = recordSyncSpawns();
		try {
			const output = await runSessionCommand(["restore", "--dry-run", "--json"]);
			expect(JSON.parse(output)).toMatchObject({ ok: true, dryRun: true, candidates: [] });
			expect(spawns.calls.some(call => call[0] === "tmux")).toBe(false);
		} finally {
			spawns.restore();
		}
		expect(snapshotTree(agentDir)).toEqual(before);
	});

	it("keeps dry-run immutable when a candidate sidecar is unreadable", async () => {
		// Attack: make state_file a directory so sidecar parsing fails. Result: no lock, SQLite row, pointer rewrite, quarantine, or tmux mutation occurs.
		const project = path.join(root, "project");
		const stateDirectory = path.join(project, "state-directory");
		mkdirSync(stateDirectory, { recursive: true });
		const poisoned = pointer({ state_file: stateDirectory, boot: changedCurrentBoot() });
		writePointer(path.join(restorePointerDirectory(), "sidecar-directory.json"), poisoned);
		const before = snapshotTree(agentDir);
		const spawns = recordSyncSpawns();
		try {
			const output = await runSessionCommand(["restore", "--dry-run", "--json"]);
			expect(JSON.parse(output)).toMatchObject({ ok: true, dryRun: true });
			expect(spawns.calls.some(call => call[0] === "tmux")).toBe(false);
		} finally {
			spawns.restore();
		}
		expect(snapshotTree(agentDir)).toEqual(before);
	});

	it("keeps dry-run immutable when the recorded cwd no longer exists", async () => {
		// Attack: provide a sidecar and transcript but a deleted cwd. Result: candidate is refused before any create path and the agent tree is byte-for-byte unchanged.
		const project = path.join(root, "project");
		mkdirSync(project, { recursive: true });
		const transcript = path.join(project, "transcript.jsonl");
		const stateFile = path.join(project, "state.json");
		writeFileSync(transcript, "{}\n");
		writeFileSync(
			stateFile,
			JSON.stringify({ session_id: "coord-redteam", state: "running", session_file: transcript }),
		);
		const missingCwd = path.join(root, "deleted-cwd");
		const stale = pointer({
			state_file: stateFile,
			session_file: transcript,
			cwd: missingCwd,
			boot: changedCurrentBoot(),
		});
		writePointer(path.join(restorePointerDirectory(), "missing-cwd.json"), stale);
		const before = snapshotTree(agentDir);
		const spawns = recordSyncSpawns();
		try {
			const output = await runSessionCommand(["restore", "--dry-run", "--json"]);
			expect(JSON.parse(output)).toMatchObject({ ok: true, dryRun: true });
			expect(spawns.calls.some(call => call[0] === "tmux")).toBe(false);
		} finally {
			spawns.restore();
		}
		expect(snapshotTree(agentDir)).toEqual(before);
	});

	it("short-circuits expensive sidecar and live-census checks when reboot proof is absent", () => {
		// Attack: use a same-boot record to induce an expensive check that might be fooled. Result: reboot gate returns first and no later dependency runs.
		let sidecarReads = 0;
		let censusReads = 0;
		const verdict = evaluateRestoreCandidate(
			pointer(),
			candidateDeps({
				currentBoot: { source: "darwin-kern-boottime", value: "1.000001" },
				readSidecar: () => {
					sidecarReads += 1;
					return null;
				},
				hasLiveIdentity: () => {
					censusReads += 1;
					return false;
				},
			}),
		);
		expect(verdict).toMatchObject({ eligible: false, reason: "same_boot" });
		expect(sidecarReads).toBe(0);
		expect(censusReads).toBe(0);
	});
});
