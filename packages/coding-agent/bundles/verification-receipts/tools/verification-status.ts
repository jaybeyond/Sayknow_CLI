/**
 * verification-receipts: exec core shared by the tools (bounded spawn, git, freshness fingerprint,
 * private receipt store) plus the `verification_status` tool.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin
 * `verification-receipts` (MIT, Copyright (c) 2026 jjongguet). See NOTICE.md and LICENSE.gjc-plugin.
 */
import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomToolAPI } from "@sayknow-cli/coding-agent";
import { StoreBusyError, withLock } from "../hooks/verification-baseline";
import {
	type Execution,
	ensureChain,
	envelopeOf,
	errCode,
	eventsParts,
	type FingerprintCounts,
	type FingerprintReason,
	type Freshness,
	fsyncDir,
	type GitSubreason,
	type HookFs,
	isUuid,
	RECEIPT_BYTES_PER_REPO,
	RECEIPT_MAX_BYTES,
	RECEIPTS_PER_REPO,
	type Receipt,
	readCapped,
	resolveStoreRoot,
	type SourceFingerprint,
	sha256Hex,
	UUID,
	validateEnvelope,
	writeNew,
} from "../hooks/verification-gate";
import {
	DIFF_FILES_ARGS,
	FILTER_CONFIG_ARGS,
	GIT_PINS,
	hasUnsupportedFilter,
	RecordSplitter,
} from "./verification-git";

// ---------------------------------------------------------------------------
// Bounded spawn (the only process launcher; never pi.exec)
// ---------------------------------------------------------------------------

export type SpawnMode =
	| { kind: "capture"; cap: number }
	| { kind: "stream"; cap: number; onChunk: (chunk: Uint8Array) => void }
	| { kind: "drain"; ceiling: number };

export interface SpawnSpec {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	mode: SpawnMode;
	signal?: AbortSignal;
	/** Injectable overall output ceiling (all modes count stdout+stderr). */
	ceiling?: number;
}
export type SpawnOutcome =
	| "exited"
	| "signaled"
	| "timeout"
	| "output_limit"
	| "cancelled"
	| "spawn_failed"
	/** A stream reader failed or did not finish after exit: captured output may be a prefix. */
	| "output_incomplete";
export interface SpawnResult {
	outcome: SpawnOutcome;
	exitCode: number | null;
	signal: string | null;
	stdout: Buffer;
	stderrTail: string;
	outputBytes: number;
	groupCleanup: "confirmed" | "unconfirmed";
	error?: string;
}

const COMBINED_OUTPUT_CEILING = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const TERM_GRACE_MS = 2000;
const REAP_MS = 2500;
const CONFIRM_MS = 1000;

function sleepMs(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// ESRCH: already gone.
	}
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (groupAlive(pgid)) {
		if (Date.now() >= end) return false;
		await sleepMs(25);
	}
	return true;
}

/** SIGTERM the group, SIGKILL after 2 s, reap <= 2.5 s, confirm <= 1 s via kill(-pgid, 0) == ESRCH. */
async function terminateGroup(pgid: number, exited: Promise<unknown>): Promise<boolean> {
	signalGroup(pgid, "SIGTERM");
	if (!(await waitGroupGone(pgid, TERM_GRACE_MS))) signalGroup(pgid, "SIGKILL");
	await Promise.race([exited, sleepMs(REAP_MS)]);
	return await waitGroupGone(pgid, CONFIRM_MS);
}

export async function resolveExecutable(name: string, pathEnv: string | undefined): Promise<string | null> {
	for (const dir of (pathEnv ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		try {
			await fs.access(candidate, fs.constants.X_OK);
			const real = await fs.realpath(candidate);
			if ((await fs.stat(real)).isFile()) return real;
		} catch {
			// next PATH entry
		}
	}
	return null;
}

export function buildEnv(kind: "git" | "runner", source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const names =
		kind === "git"
			? ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]
			: ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG"];
	const env: Record<string, string> = {};
	for (const name of names) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	if (kind === "git") Object.assign(env, { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
	else Object.assign(env, { TZ: "UTC", NO_COLOR: "1" });
	return env;
}

export async function boundedSpawn(spec: SpawnSpec): Promise<SpawnResult> {
	const empty: SpawnResult = {
		outcome: "spawn_failed",
		exitCode: null,
		signal: null,
		stdout: Buffer.alloc(0),
		stderrTail: "",
		outputBytes: 0,
		groupCleanup: "confirmed",
	};
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(spec.argv, {
			cwd: spec.cwd,
			env: spec.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (error) {
		return { ...empty, error: String(error) };
	}
	const pgid = proc.pid;
	const ceiling = spec.ceiling ?? (spec.mode.kind === "drain" ? spec.mode.ceiling : COMBINED_OUTPUT_CEILING);
	let reason: "timeout" | "output_limit" | "cancelled" | null = null;
	let cleanup: Promise<boolean> | null = null;
	const kill = (why: "timeout" | "output_limit" | "cancelled"): void => {
		reason ??= why;
		cleanup ??= terminateGroup(pgid, proc.exited);
	};
	const timer = setTimeout(() => kill("timeout"), spec.timeoutMs);
	const onAbort = (): void => kill("cancelled");
	if (spec.signal?.aborted) onAbort();
	spec.signal?.addEventListener("abort", onAbort, { once: true });

	let total = 0;
	const captured: Buffer[] = [];
	let capturedBytes = 0;
	let stderrBuf = Buffer.alloc(0);
	const readOut = async (): Promise<void> => {
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			total += chunk.byteLength;
			if (total > ceiling) return kill("output_limit");
			if (spec.mode.kind === "capture") {
				capturedBytes += chunk.byteLength;
				if (capturedBytes > spec.mode.cap) return kill("output_limit");
				captured.push(Buffer.from(chunk));
			} else if (spec.mode.kind === "stream") {
				capturedBytes += chunk.byteLength;
				if (capturedBytes > spec.mode.cap) return kill("output_limit");
				spec.mode.onChunk(chunk);
			}
		}
	};
	const readErr = async (): Promise<void> => {
		for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
			total += chunk.byteLength;
			stderrBuf = Buffer.concat([stderrBuf, chunk]);
			if (stderrBuf.byteLength > STDERR_TAIL_BYTES)
				stderrBuf = stderrBuf.subarray(stderrBuf.byteLength - STDERR_TAIL_BYTES);
			if (total > ceiling) return kill("output_limit");
		}
	};
	let readerFailed = false;
	const guard = (read: Promise<void>): Promise<void> =>
		read.catch(() => {
			readerFailed = true;
		});
	const readers = Promise.all([guard(readOut()), guard(readErr())]);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	spec.signal?.removeEventListener("abort", onAbort);
	// The leader is gone; surviving group members are swept so no descendant outlives the call.
	if (!cleanup && groupAlive(pgid)) cleanup = terminateGroup(pgid, proc.exited);
	const confirmed = cleanup ? await cleanup : true;
	const readersDone = await Promise.race([readers.then(() => true), sleepMs(CONFIRM_MS).then(() => false)]);
	const signal = typeof proc.signalCode === "string" ? proc.signalCode : null;
	const outcome: SpawnOutcome =
		reason ?? (readerFailed || !readersDone ? "output_incomplete" : signal ? "signaled" : "exited");
	return {
		outcome,
		exitCode: typeof exitCode === "number" ? exitCode : null,
		signal,
		stdout: Buffer.concat(captured),
		stderrTail: stderrBuf.toString("utf8"),
		outputBytes: total,
		groupCleanup: confirmed ? "confirmed" : "unconfirmed",
	};
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitContext {
	cwd: string;
	gitPath: string | null;
	env: Record<string, string>;
	timeoutMs: number;
}
export type GitResult = { ok: true; exitCode: number; stdout: Buffer } | { ok: false; sub: GitSubreason };

export async function makeGitContext(
	cwd: string,
	timeoutMs = 5000,
	source: NodeJS.ProcessEnv = process.env,
): Promise<GitContext> {
	const env = buildEnv("git", source);
	return { cwd, gitPath: await resolveExecutable("git", env.PATH), env, timeoutMs };
}

export async function runGit(g: GitContext, args: string[], mode: SpawnMode): Promise<GitResult> {
	if (!g.gitPath) return { ok: false, sub: "spawn_failed" };
	const result = await boundedSpawn({
		argv: [g.gitPath, "--no-optional-locks", ...GIT_PINS, ...args],
		cwd: g.cwd,
		env: g.env,
		timeoutMs: g.timeoutMs,
		mode,
	});
	if (result.outcome === "timeout") return { ok: false, sub: "git_timeout" };
	if (result.outcome === "output_limit") return { ok: false, sub: "git_output_limit" };
	if (result.outcome !== "exited" || result.exitCode === null) {
		return { ok: false, sub: result.outcome === "spawn_failed" ? "spawn_failed" : "git_failed" };
	}
	return { ok: true, exitCode: result.exitCode, stdout: result.stdout };
}

export type RepoResolution =
	| { ok: true; toplevel: string; repoDigest: string; git: GitContext }
	| { ok: false; reason: "not_a_repository" | "git_unavailable" | "repo_identity_mismatch"; sub?: GitSubreason };

/**
 * `git rev-parse --show-toplevel` (realpath) must equal the filesystem-walk toplevel from `cwd`.
 * The returned `git` context runs at the toplevel: ls-files/--others are cwd-scoped and cwd-relative otherwise.
 */
export async function resolveRepo(g: GitContext, cwd: string): Promise<RepoResolution> {
	const r = await runGit(g, ["rev-parse", "--show-toplevel"], { kind: "capture", cap: 64 * 1024 });
	if (!r.ok) return { ok: false, reason: "git_unavailable", sub: r.sub };
	if (r.exitCode !== 0) return { ok: false, reason: "not_a_repository" };
	const toplevel = await fs.realpath(r.stdout.toString("utf8").trim()).catch(() => null);
	if (!toplevel) return { ok: false, reason: "not_a_repository" };
	const real = await fs.realpath(cwd).catch(() => null);
	const walked = real ? await walkToplevel(real) : null;
	if (!walked || (await fs.realpath(walked).catch(() => null)) !== toplevel) {
		return { ok: false, reason: "repo_identity_mismatch" };
	}
	return { ok: true, toplevel, repoDigest: sha256Hex(toplevel), git: { ...g, cwd: toplevel } };
}

// ---------------------------------------------------------------------------
// Freshness fingerprint
// ---------------------------------------------------------------------------

export interface FingerprintLimits {
	maxIndexEntries: number;
	maxDirtyPaths: number;
	maxDirtyBytes: number;
}
export const DEFAULT_LIMITS: FingerprintLimits = {
	maxIndexEntries: 200_000,
	maxDirtyPaths: 5000,
	maxDirtyBytes: 64 * 1024 * 1024,
};
const INDEX_STREAM_CAP = 64 * 1024 * 1024;
const STATUS_CAP = 16 * 1024 * 1024;
const INDEX_RECORD = /^[0-7]{6} [0-9a-f]{40,64} [0-3]\t[^\0]+$/;

class Unavailable extends Error {
	constructor(
		readonly reason: FingerprintReason,
		readonly sub: GitSubreason | null = null,
	) {
		super(reason);
	}
}

const unavailable = (
	reason: FingerprintReason,
	sub: GitSubreason | null,
	head: string | null,
	counts: FingerprintCounts,
): SourceFingerprint => ({
	status: "unavailable",
	reason,
	subreason: sub,
	head,
	sourceDigest: null,
	selectedDigest: null,
	digest: null,
	counts,
});

function sameStat(a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }, b: typeof a): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** Only ENOENT/ENOTDIR mean "absent"; every other filesystem error is `source_unreadable`, never a digest. */
function fsUnavailable(error: unknown, absent: FingerprintReason): Unavailable {
	const code = errCode(error);
	return new Unavailable(code === "ENOENT" || code === "ENOTDIR" ? absent : "source_unreadable");
}

async function lstatOrAbsent(abs: string): Promise<Stats | null> {
	try {
		return await fs.lstat(abs);
	} catch (error) {
		const failure = fsUnavailable(error, "observed_source");
		if (failure.reason === "observed_source") return null;
		throw failure;
	}
}

async function hashRegularFile(abs: string, expectedMaxBytes: number): Promise<{ hash: string; bytes: number }> {
	const before = await fs.lstat(abs, { bigint: true }).catch((error: unknown) => {
		throw fsUnavailable(error, "changed_while_hashing");
	});
	let handle: Awaited<ReturnType<typeof fs.open>>;
	try {
		handle = await fs.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") throw new Unavailable("source_unreadable");
		throw new Unavailable("changed_while_hashing");
	}
	try {
		const hash = crypto.createHash("sha256");
		const buf = Buffer.allocUnsafe(64 * 1024);
		let bytes = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buf, 0, buf.byteLength, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			if (bytes > expectedMaxBytes) throw new Unavailable("byte_limit");
			hash.update(buf.subarray(0, bytesRead));
		}
		const after = await handle.stat({ bigint: true });
		if (!sameStat(before, after) || BigInt(bytes) !== after.size) throw new Unavailable("changed_while_hashing");
		return { hash: hash.digest("hex"), bytes };
	} finally {
		await handle.close();
	}
}

/** False when a parent directory is missing (path counts as deleted); throws `reason` for a symlinked parent. */
async function parentsSafe(
	toplevel: string,
	rel: string,
	cache: Map<string, "dir" | "link" | "missing">,
	reason: FingerprintReason,
): Promise<boolean> {
	const parts = rel.split("/");
	let current = toplevel;
	for (let i = 0; i < parts.length - 1; i++) {
		current = path.join(current, parts[i] ?? "");
		let state = cache.get(current);
		if (!state) {
			const st = await lstatOrAbsent(current);
			state = !st ? "missing" : st.isSymbolicLink() ? "link" : "dir";
			cache.set(current, state);
		}
		if (state === "link") throw new Unavailable(reason);
		if (state === "missing") return false;
	}
	return true;
}

/** Source part of the fingerprint: head, full index, and the dirty frame. Never returns a prefix digest. */
export async function sourceFingerprint(
	caller: GitContext,
	toplevel: string,
	limits: FingerprintLimits = DEFAULT_LIMITS,
): Promise<SourceFingerprint> {
	const g: GitContext = { ...caller, cwd: toplevel };
	const counts: FingerprintCounts = { indexEntries: 0, dirtyPaths: 0, hashedBytes: 0 };
	let head: string | null = null;
	try {
		const rootStat = await fs.lstat(toplevel).catch(() => null);
		if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Unavailable("unsafe_root");
		const headRes = await runGit(g, ["rev-parse", "--verify", "-q", "HEAD"], { kind: "capture", cap: 64 * 1024 });
		if (!headRes.ok) throw new Unavailable("git_unavailable", headRes.sub);
		if (headRes.exitCode === 0) head = headRes.stdout.toString("utf8").trim();
		else if (headRes.exitCode !== 1) throw new Unavailable("git_unavailable", "git_failed");

		// R3-5: a repo-local clean filter can hide an edit from `git status`; global git-lfs is not examined.
		const filterRes = await runGit(g, FILTER_CONFIG_ARGS, { kind: "capture", cap: 256 * 1024 });
		if (!filterRes.ok) throw new Unavailable("git_unavailable", filterRes.sub);
		if (filterRes.exitCode > 1) throw new Unavailable("git_unavailable", "git_failed");
		if (filterRes.exitCode === 0 && hasUnsupportedFilter(filterRes.stdout.toString("utf8")))
			throw new Unavailable("unsupported_config");

		const indexHash = crypto.createHash("sha256");
		const gitlinks = new Set<string>();
		let indexError: FingerprintReason | null = null;
		const indexSplit = new RecordSplitter(record => {
			counts.indexEntries++;
			if (counts.indexEntries > limits.maxIndexEntries) indexError ??= "file_limit";
			const text = record.toString("utf8");
			if (!INDEX_RECORD.test(text)) indexError ??= "invalid_index";
			else if (text.startsWith("160000 ")) gitlinks.add(text.slice(text.indexOf("\t") + 1));
		});
		const indexRes = await runGit(g, ["ls-files", "--stage", "-z"], {
			kind: "stream",
			cap: INDEX_STREAM_CAP,
			onChunk: chunk => {
				indexHash.update(chunk);
				indexSplit.push(chunk);
			},
		});
		if (!indexRes.ok) throw new Unavailable("git_unavailable", indexRes.sub);
		if (indexRes.exitCode !== 0) throw new Unavailable("git_unavailable", "git_failed");
		if (indexError) throw new Unavailable(indexError);
		if (!indexSplit.finish()) throw new Unavailable("invalid_index");

		const flagged = new Set<string>();
		const flagSplit = new RecordSplitter(record => {
			const tag = String.fromCharCode(record[0] ?? 0);
			if (record[1] === 0x20 && (tag === "S" || (tag >= "a" && tag <= "z")))
				flagged.add(record.subarray(2).toString("utf8"));
		});
		const flagRes = await runGit(g, ["ls-files", "-v", "-z"], {
			kind: "stream",
			cap: INDEX_STREAM_CAP,
			onChunk: c => flagSplit.push(c),
		});
		if (!flagRes.ok) throw new Unavailable("git_unavailable", flagRes.sub);
		if (flagRes.exitCode !== 0) throw new Unavailable("git_unavailable", "git_failed");
		if (!flagSplit.finish()) throw new Unavailable("invalid_index");

		const statusRes = await runGit(
			g,
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"],
			{ kind: "capture", cap: STATUS_CAP },
		);
		if (!statusRes.ok) throw new Unavailable("git_unavailable", statusRes.sub);
		if (statusRes.exitCode !== 0) throw new Unavailable("git_unavailable", "git_failed");
		const dirty = new Set<string>(flagged);
		for (const rec of statusRes.stdout.toString("utf8").split("\0")) {
			if (rec.length < 4) continue;
			const rel = rec.slice(3);
			if (rec.startsWith("??") && rel.split("/").includes(".skc")) continue;
			dirty.add(rel);
		}
		// R4-3: stat-dirty tracked paths that `git status` may hide behind a check-in conversion are hashed raw too.
		const statRes = await runGit(g, DIFF_FILES_ARGS, { kind: "capture", cap: STATUS_CAP });
		if (!statRes.ok) throw new Unavailable("git_unavailable", statRes.sub);
		if (statRes.exitCode !== 0) throw new Unavailable("git_unavailable", "git_failed");
		for (const rel of statRes.stdout.toString("utf8").split("\0")) if (rel) dirty.add(rel);
		counts.dirtyPaths = dirty.size;
		if (dirty.size > limits.maxDirtyPaths) throw new Unavailable("file_limit");

		const frame = crypto.createHash("sha256");
		const parentCache = new Map<string, "dir" | "link" | "missing">();
		for (const rel of [...dirty].sort()) {
			if (gitlinks.has(rel)) throw new Unavailable("submodule_dirty");
			const parentOk = await parentsSafe(toplevel, rel, parentCache, "symlink_parent");
			const st = parentOk ? await lstatOrAbsent(path.join(toplevel, rel)) : null;
			if (!st) frame.update(`${rel}\0deleted\0\n`);
			else if (st.isSymbolicLink()) {
				frame.update(`${rel}\0link\0${await fs.readlink(path.join(toplevel, rel))}\n`);
			} else if (st.isFile()) {
				const { hash, bytes } = await hashRegularFile(
					path.join(toplevel, rel),
					limits.maxDirtyBytes - counts.hashedBytes,
				);
				counts.hashedBytes += bytes;
				frame.update(`${rel}\0file\0${(st.mode & 0o7777).toString(8)}\0${hash}\n`);
			} else throw new Unavailable("unsupported_file");
		}
		const sourceDigest = sha256Hex(
			["v1", head ?? "", indexHash.digest("hex"), String(counts.indexEntries), frame.digest("hex")].join("\n"),
		);
		return {
			status: "available",
			reason: "observed_source",
			subreason: null,
			head,
			sourceDigest,
			selectedDigest: null,
			digest: null,
			counts,
		};
	} catch (error) {
		if (error instanceof Unavailable) return unavailable(error.reason, error.sub, head, counts);
		if (typeof errCode(error) === "string") return unavailable("source_unreadable", null, head, counts);
		throw error;
	}
}

/** Digest of the selected test files (regular, non-symlink, hashed even when gitignored). */
export async function selectedDigestOf(
	toplevel: string,
	selectedInputs: readonly string[],
	specDigest: string,
): Promise<{ digest: string; bytes: number } | { reason: FingerprintReason }> {
	const frame = crypto.createHash("sha256").update(specDigest);
	const cache = new Map<string, "dir" | "link" | "missing">();
	let bytes = 0;
	try {
		for (const rel of [...selectedInputs].sort()) {
			const abs = path.join(toplevel, rel);
			if (!(await parentsSafe(toplevel, rel, cache, "unsafe_selected_input")))
				throw new Unavailable("selected_input_unavailable");
			const st = await lstatOrAbsent(abs);
			if (!st) throw new Unavailable("selected_input_unavailable");
			if (st.isSymbolicLink() || !st.isFile()) throw new Unavailable("unsafe_selected_input");
			const res = await hashRegularFile(abs, Number.MAX_SAFE_INTEGER);
			bytes += res.bytes;
			frame.update(`${rel}\0${(st.mode & 0o7777).toString(8)}\0${res.hash}\n`);
		}
		return { digest: frame.digest("hex"), bytes };
	} catch (error) {
		if (error instanceof Unavailable) return { reason: error.reason };
		if (typeof errCode(error) === "string") return { reason: "source_unreadable" };
		throw error;
	}
}

export async function fingerprint(
	g: GitContext,
	toplevel: string,
	selectedInputs: readonly string[],
	specDigest: string,
	limits: FingerprintLimits = DEFAULT_LIMITS,
): Promise<SourceFingerprint> {
	const source = await sourceFingerprint(g, toplevel, limits);
	if (source.status !== "available" || source.sourceDigest === null) return source;
	const selected = await selectedDigestOf(toplevel, selectedInputs, specDigest);
	if ("reason" in selected) return unavailable(selected.reason, null, source.head, source.counts);
	return {
		...source,
		selectedDigest: selected.digest,
		digest: sha256Hex(`${source.sourceDigest}\n${selected.digest}`),
		counts: { ...source.counts, hashedBytes: source.counts.hashedBytes + selected.bytes },
	};
}

export function runFreshness(before: SourceFingerprint, after: SourceFingerprint): Freshness {
	if (before.status !== "available" || after.status !== "available") return "unavailable";
	return before.digest === after.digest ? "fresh" : "changed_during_run";
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export function receiptDir(storeRoot: string, repoDigest: string): string {
	return path.join(storeRoot, "receipts", "v1", repoDigest);
}

export type StorageStatus = "stored" | "store_busy" | "store_unavailable" | "store_corrupt" | "receipt_unavailable";
const RECEIPT_FILE = /^([0-9a-f-]{36})\.json$/;
const RECEIPT_TEMP = /^\.tmp-[0-9a-f]{16}$/;

async function readReceiptFile(fsx: HookFs, dir: string, id: string): Promise<Receipt | null> {
	try {
		const buf = await readCapped(fsx, path.join(dir, `${id}.json`), RECEIPT_MAX_BYTES, true);
		return validateEnvelope(JSON.parse(buf.toString("utf8")), id);
	} catch {
		return null;
	}
}

/** Immutable publish: temp O_EXCL, link (never replace), unlink temp, re-read + compare, fsync dir. */
export async function storeReceipt(fsx: HookFs, storeRoot: string, receipt: Receipt): Promise<StorageStatus> {
	try {
		const dir = await ensureChain(fsx, storeRoot, ["receipts", "v1", receipt.repositoryDigest], true);
		if (!dir) return "store_unavailable";
		const body = JSON.stringify(envelopeOf(receipt));
		if (Buffer.byteLength(body) > RECEIPT_MAX_BYTES) return "receipt_unavailable";
		return await withLock(fsx, path.join(dir, ".admission.lock"), { pidAlive }, async () => {
			const names = await fsx.readdir(dir);
			const owned: Array<{ id: string; size: number; mtimeMs: number }> = [];
			for (const name of names) {
				if (name === ".admission.lock" || RECEIPT_TEMP.test(name)) continue;
				const m = name.match(RECEIPT_FILE);
				if (!m?.[1] || !isUuid(m[1])) return "store_corrupt" as StorageStatus;
				const st = await fsx.lstat(path.join(dir, name));
				if (!st.isFile()) return "store_corrupt" as StorageStatus;
				owned.push({ id: m[1], size: st.size, mtimeMs: st.mtimeMs });
			}
			owned.sort((a, b) => a.mtimeMs - b.mtimeMs);
			let count = owned.length;
			let bytes = owned.reduce((n, o) => n + o.size, 0);
			while (count >= RECEIPTS_PER_REPO || bytes + Buffer.byteLength(body) > RECEIPT_BYTES_PER_REPO) {
				const oldest = owned.shift();
				if (!oldest) break;
				if (!(await readReceiptFile(fsx, dir, oldest.id))) return "store_corrupt" as StorageStatus;
				await fsx.unlink(path.join(dir, `${oldest.id}.json`));
				count--;
				bytes -= oldest.size;
			}
			const temp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
			const final = path.join(dir, `${receipt.id}.json`);
			await writeNew(fsx, temp, body);
			try {
				await fsx.link(temp, final);
			} finally {
				await fsx.unlink(temp).catch(() => undefined);
			}
			const reread = await readCapped(fsx, final, RECEIPT_MAX_BYTES, true);
			if (reread.toString("utf8") !== body) return "store_corrupt" as StorageStatus;
			await fsyncDir(fsx, dir);
			return "stored" as StorageStatus;
		});
	} catch (error) {
		if (error instanceof StoreBusyError) return "store_busy";
		return "store_unavailable";
	}
}

export async function loadReceipt(
	fsx: HookFs,
	storeRoot: string,
	repoDigest: string,
	id: string,
): Promise<Receipt | null> {
	if (!isUuid(id)) return null;
	try {
		const dir = await ensureChain(fsx, storeRoot, ["receipts", "v1", repoDigest], false);
		return dir ? await readReceiptFile(fsx, dir, id) : null;
	} catch {
		return null;
	}
}

/** All valid receipts of a repo, newest first (bounded to 200 by admission). */
export async function loadRepoReceipts(fsx: HookFs, storeRoot: string, repoDigest: string): Promise<Receipt[]> {
	const dir = await ensureChain(fsx, storeRoot, ["receipts", "v1", repoDigest], false);
	if (!dir) return [];
	const out: Receipt[] = [];
	for (const name of (await fsx.readdir(dir)).slice(0, RECEIPTS_PER_REPO + 8)) {
		const id = name.match(RECEIPT_FILE)?.[1];
		const receipt = id ? await readReceiptFile(fsx, dir, id) : null;
		if (receipt) out.push(receipt);
	}
	return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ---------------------------------------------------------------------------
// Tool runtime shared by run / status / loop
// ---------------------------------------------------------------------------

export type ToolStoreFailure = {
	ok: false;
	status: "store_unavailable";
	reason: "project_scope_unsupported" | "uninstalled_layout" | "layout_mismatch" | "unsafe_permissions";
};
export type ToolStore = { ok: true; storeRoot: string; agentDir: string } | ToolStoreFailure;

/** Compare the install layout with the live agent dir; both sides are realpath-normalized. */
export async function openToolStore(pi: CustomToolAPI, toolDir: string): Promise<ToolStore> {
	const resolution = resolveStoreRoot(toolDir);
	if (!resolution.ok) return { ok: false, status: "store_unavailable", reason: resolution.reason };
	const [installed, live] = await Promise.all([
		fs.realpath(resolution.agentDir).catch(() => null),
		fs.realpath(pi.pi.getAgentDir()).catch(() => null),
	]);
	if (!installed || installed !== live) return { ok: false, status: "store_unavailable", reason: "layout_mismatch" };
	try {
		if (!(await ensureChain(fs, resolution.storeRoot, [], true)))
			return { ok: false, status: "store_unavailable", reason: "unsafe_permissions" };
	} catch {
		return { ok: false, status: "store_unavailable", reason: "unsafe_permissions" };
	}
	return { ok: true, storeRoot: resolution.storeRoot, agentDir: installed };
}

export function jsonResult<T extends object>(
	details: T,
): { content: Array<{ type: "text"; text: string }>; details: T } {
	return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export interface SnapshotEvent {
	at: number;
	sourceDigest: string;
	head: string | null;
	by: "run" | "status";
}

/** Snapshots travel as lock-free events; the loop merges them into the ledger. Failure -> warning. */
export async function writeSnapshotEvent(
	store: { storeRoot: string },
	repoDigest: string,
	sessionDigest: string,
	snapshot: SnapshotEvent,
): Promise<boolean> {
	try {
		const dir = await ensureChain(fs, store.storeRoot, eventsParts(repoDigest, sessionDigest), true);
		if (!dir || (await fs.readdir(dir)).length >= 1024) return false;
		const name = `${String(snapshot.at).padStart(13, "0")}-snapshot-${crypto.randomBytes(4).toString("hex")}.json`;
		await writeNew(fs, path.join(dir, name), JSON.stringify({ v: 1, kind: "snapshot", ...snapshot }));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// verification_status tool
// ---------------------------------------------------------------------------

export interface StatusParams {
	receiptId: string;
}
interface ToolCtx {
	sessionManager: { getSessionId(): string };
}

export interface StatusDetails {
	status: "ok" | "not_found" | "store_unavailable" | "blocked";
	reason: string | null;
	receiptId: string;
	storage: StorageStatus | null;
	execution: Execution | null;
	storedFreshness: Freshness | null;
	freshness: Freshness | null;
	recomputed: {
		status: string;
		reason: string;
		subreason: GitSubreason | null;
		digest: string | null;
		counts: FingerprintCounts;
	} | null;
	advisoryOnly: true;
}

export async function runStatus(pi: CustomToolAPI, ctx: ToolCtx, params: StatusParams): Promise<StatusDetails> {
	const base: StatusDetails = {
		status: "not_found",
		reason: null,
		receiptId: params.receiptId,
		storage: null,
		execution: null,
		storedFreshness: null,
		freshness: null,
		recomputed: null,
		advisoryOnly: true,
	};
	if (!isUuid(params.receiptId)) return { ...base, status: "blocked", reason: "invalid_receipt_id" };
	if (process.platform === "win32") return { ...base, status: "blocked", reason: "platform_unsupported" };
	const store = await openToolStore(pi, import.meta.dir);
	if (!store.ok) return { ...base, status: "store_unavailable", reason: store.reason, storage: "store_unavailable" };
	const repo = await resolveRepo(await makeGitContext(pi.cwd), pi.cwd);
	if (!repo.ok) return { ...base, status: "blocked", reason: repo.reason };
	const receipt = await loadReceipt(fs, store.storeRoot, repo.repoDigest, params.receiptId);
	if (!receipt) return { ...base, storage: "receipt_unavailable" };
	const fp = await fingerprint(repo.git, repo.toplevel, receipt.selectedInputs, receipt.specDigest);
	const freshness: Freshness =
		fp.status !== "available" ? "unavailable" : fp.digest === receipt.after.digest ? "fresh" : "stale";
	if (fp.sourceDigest) {
		await writeSnapshotEvent(store, repo.repoDigest, sha256Hex(ctx.sessionManager.getSessionId()), {
			at: Date.now(),
			sourceDigest: fp.sourceDigest,
			head: fp.head,
			by: "status",
		});
	}
	return {
		...base,
		status: "ok",
		storage: "stored",
		execution: receipt.execution,
		storedFreshness: receipt.freshness,
		freshness,
		recomputed: {
			status: fp.status,
			reason: fp.reason,
			subreason: fp.subreason,
			digest: fp.digest,
			counts: fp.counts,
		},
	};
}

/** Nearest ancestor containing `.git` (directory or file), the filesystem-walk toplevel. */
export async function walkToplevel(start: string): Promise<string | null> {
	let dir = start;
	for (let i = 0; i < 64; i++) {
		if (await fs.lstat(path.join(dir, ".git")).catch(() => null)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

export default function verificationStatusTool(pi: CustomToolAPI) {
	const z = pi.zod;
	return {
		name: "verification_status",
		label: "Verification Status",
		description:
			"Recompute the freshness of a stored verification receipt without rerunning tests: fresh, stale or unavailable. Advisory only.",
		strict: true,
		concurrency: "shared" as const,
		parameters: z.strictObject({
			receiptId: z.string().regex(UUID).describe("receipt id returned by verification_run"),
		}),
		async execute(_toolCallId: string, params: StatusParams, _onUpdate: unknown, ctx: ToolCtx) {
			try {
				return jsonResult(await runStatus(pi, ctx, params));
			} catch (error) {
				pi.logger.warn("verification_status failed", { error: String(error) });
				return jsonResult<StatusDetails>({
					status: "blocked",
					reason: "state_unavailable",
					receiptId: String(params.receiptId),
					storage: null,
					execution: null,
					storedFreshness: null,
					freshness: null,
					recomputed: null,
					advisoryOnly: true,
				});
			}
		},
	};
}
