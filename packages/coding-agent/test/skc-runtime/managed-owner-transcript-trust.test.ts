import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	trustedManagedOwnerLaunchSessionFile,
	trustedManagedOwnerTranscriptPath,
} from "@sayknow-cli/coding-agent/skc-runtime/managed-owner-admission";
import { sessionStateDir, sessionUltragoalDir } from "@sayknow-cli/coding-agent/skc-runtime/session-layout";
import { lifecyclePaths } from "@sayknow-cli/coding-agent/skc-runtime/tmux-owner-isolation";

const recoveryReads = process.platform === "linux";
const sessionId = "session-2681";
const canary = "FORGED-TERMINAL-CANARY";
const admissionModule = path.join(import.meta.dir, "..", "..", "src", "skc-runtime", "managed-owner-admission.ts");
const transcriptBody =
	`{"id":"one","parentId":null,"type":"message"}\n` +
	`{"id":"two","parentId":"one","type":"yield","result":{"status":"success","note":"${canary}"}}\n` +
	`{"id":"three","parentId":"two","type":"toolResult","toolCallId":"two","content":[]}\n`;

async function tempProject(): Promise<string> {
	return await fsp.mkdtemp(path.join(os.tmpdir(), "skc-owner-transcript-"));
}

// Ported from upstream gajae 53800c6046 (#6658). The fork forwards the replacement
// transcript from sdk/bus/lifecycle-control-runtime.ts (daemon create/resume), not
// from launch-tmux, so the upstream launchDefaultTmuxIfNeeded case is covered by
// the provenance helper tests here.
describe("managed owner transcript provenance", () => {
	it("keeps an operator transcript path the project does not declare", async () => {
		const cwd = await tempProject();
		try {
			await fsp.writeFile(path.join(cwd, ".env"), "UNRELATED=1\n");
			expect(trustedManagedOwnerTranscriptPath({ SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "operator.jsonl" }, cwd)).toBe(
				"operator.jsonl",
			);
			expect(trustedManagedOwnerLaunchSessionFile({ SKC_SESSION_FILE: "operator.jsonl" }, cwd)).toBe(
				"operator.jsonl",
			);
			expect(trustedManagedOwnerTranscriptPath({ SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "operator.jsonl " }, cwd)).toBe(
				"operator.jsonl ",
			);
			expect(trustedManagedOwnerLaunchSessionFile({ SKC_SESSION_FILE: "operator.jsonl " }, cwd)).toBe(
				"operator.jsonl ",
			);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("drops a project dotenv transcript path, including comments, quotes, and dynamic declarations", async () => {
		const cwd = await tempProject();
		try {
			await fsp.writeFile(path.join(cwd, ".env"), 'SKC_MANAGED_OWNER_TRANSCRIPT_PATH="predecessor.jsonl" # note\n');
			expect(
				trustedManagedOwnerTranscriptPath({ SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_MANAGED_OWNER_TRANSCRIPT_PATH=$(printf predecessor.jsonl)\n");
			expect(
				trustedManagedOwnerTranscriptPath({ SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_SESSION_FILE=predecessor.jsonl\n");
			expect(
				trustedManagedOwnerTranscriptPath({ SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, cwd),
			).toBe("");
			expect(trustedManagedOwnerLaunchSessionFile({ SKC_SESSION_FILE: "predecessor.jsonl" }, cwd)).toBe("");
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_SESSION_FILE=`printf predecessor.jsonl`\n");
			expect(trustedManagedOwnerLaunchSessionFile({ SKC_SESSION_FILE: "predecessor.jsonl" }, cwd)).toBe("");
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!recoveryReads)("managed owner transcript provenance through admission and launch", () => {
	it("admitManagedOwnerBeforeCli ignores a project transcript and still accepts an operator path", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skc-owner-admit-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_MANAGED_OWNER_TRANSCRIPT_PATH=predecessor.jsonl\n");
			const forged = await admit(stateDir, cwd, {});
			// The fork records a blocked admission only in the durable handoff (no stderr line; upstream blockAdmission).
			expect(forged.handoffs).toContainEqual(expect.objectContaining({ reason: "transcript_path_untrusted" }));
			expect(forged.result).toEqual({ kind: "blocked", exitCode: 75 });
			expect(await journal(cwd)).not.toContain(canary);
			await fsp.rm(path.join(cwd, ".env"), { force: true });
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, {
				SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("admitManagedOwnerBeforeCli ignores a transcript copied from the project session file", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skc-owner-admit-alias-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_SESSION_FILE=predecessor.jsonl\n");
			const forged = await admit(stateDir, cwd, {
				SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(forged.handoffs).toContainEqual(expect.objectContaining({ reason: "transcript_path_untrusted" }));
			expect(forged.result.kind).toBe("blocked");
			expect(await journal(cwd)).not.toContain(canary);
			await fsp.writeFile(path.join(cwd, ".env"), "SKC_SESSION_FILE=other.jsonl\n");
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, {
				SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl",
			});
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("completeManagedOwnerRecovery rejects a transcript declared after admission and still accepts an operator path", async () => {
		const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "skc-owner-complete-"));
		const cwd = await tempProject();
		try {
			await writePredecessor(stateDir);
			await writeTerminal(cwd);
			const changed = await admit(stateDir, cwd, { SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" }, true);
			expect(changed.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(changed.handoffs).toContainEqual(
				expect.objectContaining({ reason: "recovery_authority_changed:transcript_path_untrusted" }),
			);
			await fsp.rm(path.join(cwd, ".env"), { force: true });
			await removeJournal(cwd);
			const operator = await admit(stateDir, cwd, { SKC_MANAGED_OWNER_TRANSCRIPT_PATH: "predecessor.jsonl" });
			expect(operator.result).toEqual({ kind: "handoff", exitCode: 75 });
			expect(operator.handoffs).toContainEqual(
				expect.objectContaining({ reason: "safe_session_resume_seam_unavailable" }),
			);
		} finally {
			await fsp.rm(stateDir, { recursive: true, force: true });
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});
});

async function journal(cwd: string): Promise<string> {
	return await fsp.readFile(path.join(sessionStateDir(cwd, sessionId), "ultragoal-owner-loss-recovery.jsonl"), "utf8");
}

async function removeJournal(cwd: string): Promise<void> {
	await fsp.rm(path.join(sessionStateDir(cwd, sessionId), "ultragoal-owner-loss-recovery.jsonl"), { force: true });
}

async function writeTerminal(cwd: string): Promise<void> {
	const ultragoal = sessionUltragoalDir(cwd, sessionId);
	await fsp.mkdir(ultragoal, { recursive: true });
	await fsp.writeFile(path.join(ultragoal, "goals.json"), '{"goals":[]}');
	await fsp.writeFile(path.join(ultragoal, "ledger.jsonl"), '{"event":"started"}\n');
	await fsp.writeFile(path.join(cwd, "predecessor.jsonl"), transcriptBody);
}

async function writePredecessor(stateDir: string): Promise<void> {
	const root = lifecyclePaths(stateDir, sessionId, "generation-2681").root;
	await fsp.mkdir(root, { recursive: true });
	const command = ["skc", "--resume"];
	const commandSha256 = createHash("sha256").update(JSON.stringify(command)).digest("hex");
	const token = "predecessor";
	await fsp.writeFile(
		path.join(root, `child-${token}.binding.json`),
		`${JSON.stringify({
			schema_version: 2,
			generation: "generation-2681",
			session_id: sessionId,
			run_id: "run-2681",
			endpoint_incarnation: "incarnation-2681",
			child_token: token,
			command,
			command_sha256: commandSha256,
			supervisor_pid: 1,
			supervisor_start_time: "1",
			created_at: "2026-07-19T00:00:00.000Z",
		})}\n`,
	);
	await fsp.writeFile(
		path.join(root, `sigabrt-${token}.receipt.json`),
		`${JSON.stringify({
			schema_version: 2,
			generation: "generation-2681",
			session_id: sessionId,
			run_id: "run-2681",
			endpoint_incarnation: "incarnation-2681",
			child_token: token,
			command_sha256: commandSha256,
			supervisor_pid: 1,
			supervisor_start_time: "1",
			child_pid: 2,
			child_start_time: "2",
			signal: "SIGABRT",
			signal_number: 6,
			exit_code: null,
			received_at: "2026-07-19T00:00:00.000Z",
		})}\n`,
	);
}

async function admit(
	stateDir: string,
	cwd: string,
	extra: Record<string, string>,
	declareTranscriptBeforeComplete = false,
): Promise<{ result: { kind: string; exitCode: number }; stderr: string; handoffs: Record<string, unknown>[] }> {
	const script = `import { writeFile } from "node:fs/promises"; import { admitManagedOwnerBeforeCli, completeManagedOwnerRecovery } from ${JSON.stringify(admissionModule)}; const admission = await admitManagedOwnerBeforeCli(); if (${declareTranscriptBeforeComplete} && admission.kind === "recovery") await writeFile(".env", "SKC_MANAGED_OWNER_TRANSCRIPT_PATH=predecessor.jsonl\\n"); const terminal = admission.kind === "recovery" ? await completeManagedOwnerRecovery(admission.context) : admission; console.log(JSON.stringify({ kind: terminal.kind, exitCode: process.exitCode ?? 0 }));`;
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.SKC_SESSION_FILE;
	delete env.SKC_MANAGED_OWNER_TRANSCRIPT_PATH;
	for (const [key, value] of Object.entries(extra)) env[key] = value;
	const child = Bun.spawn({
		cmd: [process.execPath, "--no-env-file", "-e", script],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...env,
			SKC_TMUX_OWNER_STATE_DIR: stateDir,
			SKC_COORDINATOR_SESSION_ID: sessionId,
			SKC_TMUX_OWNER_GENERATION: "replacement-generation-2681",
			SKC_MANAGED_OWNER_RUN_ID: "replacement-run-2681",
			SKC_MANAGED_OWNER_INCARNATION: "replacement-incarnation-2681",
			SKC_MANAGED_OWNER_CHILD_TOKEN: "replacement-child-token",
			SKC_MANAGED_OWNER_PREDECESSOR_TOKEN: "predecessor",
			SKC_MANAGED_OWNER_PREDECESSOR_GENERATION: "generation-2681",
			SKC_MANAGED_OWNER_PREDECESSOR_RUN_ID: "run-2681",
			SKC_MANAGED_OWNER_PREDECESSOR_INCARNATION: "incarnation-2681",
		},
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (!stdout.trim()) throw new Error(stderr || `admission child exited ${exitCode} with no output`);
	const root = lifecyclePaths(stateDir, sessionId, "generation-2681").root;
	const handoffFiles = (await fsp.readdir(root)).filter(file => file.startsWith("admission-handoff-"));
	const handoffs = await Promise.all(
		handoffFiles.map(
			async file => JSON.parse(await fsp.readFile(path.join(root, file), "utf8")) as Record<string, unknown>,
		),
	);
	return {
		result: { ...(JSON.parse(stdout) as { kind: string; exitCode: number }), exitCode },
		stderr,
		handoffs,
	};
}
