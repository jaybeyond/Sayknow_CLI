/**
 * verification-receipts: hook core and shared filesystem primitives.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin
 * `verification-receipts` (MIT, Copyright (c) 2026 jjongguet). No reference code is
 * copied; see NOTICE.md and LICENSE.gjc-plugin in this bundle.
 *
 * Hook trust boundary: only `node:fs/promises`, `node:path` and `node:crypto` are used here,
 * handlers are lock-free, bounded and fail open, and they never alter `details`/`isError`.
 * The tools import this module for the store layout and private-file primitives.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const PLUGIN_NAME = "verification-receipts";
export const PLUGIN_VERSION = "0.1.0";
export const MAX_EVENT_FILES = 1024;
export const MAX_EVENT_BYTES = 8 * 1024;
export const LAUNCH_TEXT_MAX = 1600;
export const REMINDER_TEXT_MAX = 600;
export const BASELINE_BUDGET_MS = 1500;
export const GATE_BUDGET_MS = 3000;
const PARSE_TEXT_BYTES = 64 * 1024;
const MAX_JOB_LINES = 64;
const MAX_ID_CHARS = 256;
const MAX_GITDIR_LEVELS = 64;
export const HEAD_READ_CAP = 64 * 1024;

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"already_completed",
]);
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
	"running",
	"paused",
	"queued",
	"completed",
	"failed",
	"cancelled",
	"not_found",
	"already_completed",
]);

export type HookFs = typeof fs;
export interface HookLogger {
	warn(message: string, context?: Record<string, unknown>): void;
}
export interface HookDeps {
	fs: HookFs;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	budgetMs: number;
	/** Absolute `<agentDir>/skc-plugin-data/verification-receipts`, or null when hooks must not write. */
	storeRoot: string | null;
	logger?: HookLogger;
}

export interface HookCtx {
	cwd: string;
	sessionManager: { getSessionId(): string };
}
export interface HookToolEvent {
	toolName?: unknown;
	toolCallId?: unknown;
	input?: unknown;
	content?: unknown;
	details?: unknown;
	isError?: unknown;
}
interface TextBlock {
	type: "text";
	text: string;
}

// ---------------------------------------------------------------------------
// Digests and ids
// ---------------------------------------------------------------------------

export function sha256Hex(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}
/** First 16 hex of sha256: how raw job/subagent/tool-call ids are stored. */
export function d16(value: string): string {
	return sha256Hex(value).slice(0, 16);
}
export function taskGateKey(toolCallId: string): string {
	return `task:${d16(toolCallId)}`;
}
export function gateIdOf(key: string): string {
	return d16(key);
}
export function normalizeStatus(status: unknown): string {
	return typeof status === "string" && KNOWN_STATUSES.has(status) ? status : "unknown";
}

// ---------------------------------------------------------------------------
// Store layout
// ---------------------------------------------------------------------------

export type StoreResolution =
	| { ok: true; agentDir: string; storeRoot: string }
	| { ok: false; reason: "project_scope_unsupported" | "uninstalled_layout" };

/** `dir` is the directory of the tool/hook file (`import.meta.dir`). */
export function resolveStoreRoot(dir: string): StoreResolution {
	const pluginRoot = path.dirname(dir);
	const skcPlugins = path.dirname(pluginRoot);
	const agentDir = path.dirname(skcPlugins);
	const inLayout =
		(path.basename(dir) === "hooks" || path.basename(dir) === "tools") &&
		path.basename(pluginRoot) === PLUGIN_NAME &&
		path.basename(skcPlugins) === "skc-plugins";
	if (!inLayout) return { ok: false, reason: "uninstalled_layout" };
	if (path.basename(agentDir) === ".skc") return { ok: false, reason: "project_scope_unsupported" };
	return { ok: true, agentDir, storeRoot: path.join(agentDir, "skc-plugin-data", PLUGIN_NAME) };
}

export class StoreError extends Error {
	constructor(
		readonly reason: "unsafe_permissions" | "store_corrupt",
		message: string,
	) {
		super(message);
	}
}

export function errCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Verify (and optionally create) `<dataRoot>/<storeRoot>/<sub...>` one component at a time: each must be a
 * real directory owned by the caller; dataRoot may not be group/other writable, the rest must be private.
 * Returns null for a missing component when `create` is false.
 */
export async function ensureChain(
	fsx: HookFs,
	storeRoot: string,
	sub: readonly string[],
	create: boolean,
): Promise<string | null> {
	const chain: Array<[string, number]> = [
		[path.dirname(storeRoot), 0o022],
		[storeRoot, 0o077],
	];
	let current = storeRoot;
	for (const part of sub) {
		current = path.join(current, part);
		chain.push([current, 0o077]);
	}
	const uid = process.getuid?.();
	for (const [dir, mask] of chain) {
		let st = await fsx.lstat(dir).catch((error: unknown) => {
			if (errCode(error) === "ENOENT") return null;
			throw error;
		});
		if (!st) {
			if (!create) return null;
			await fsx.mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
				if (errCode(error) !== "EEXIST") throw error;
			});
			st = await fsx.lstat(dir);
		}
		if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & mask) !== 0) {
			throw new StoreError("unsafe_permissions", `unsafe store directory: ${dir}`);
		}
	}
	return current;
}

export async function fsyncDir(fsx: HookFs, dir: string): Promise<void> {
	const handle = await fsx.open(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** O_EXCL|O_NOFOLLOW 0600 create, then fstat. Never replaces an existing path. */
export async function writeNew(fsx: HookFs, file: string, data: string | Uint8Array): Promise<void> {
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	const handle = await fsx.open(file, flags, 0o600);
	try {
		await handle.writeFile(data);
		const st = await handle.stat();
		if (!st.isFile() || (st.mode & 0o077) !== 0 || st.nlink !== 1) {
			throw new StoreError("unsafe_permissions", `unsafe file after create: ${file}`);
		}
	} finally {
		await handle.close();
	}
}

/** O_NOFOLLOW read of a regular file of at most `cap` bytes (and nlink 1 when `singleLink`). */
export async function readCapped(fsx: HookFs, file: string, cap: number, singleLink = false): Promise<Buffer> {
	const handle = await fsx.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.size > cap || (singleLink && st.nlink !== 1)) {
			throw new StoreError("store_corrupt", `unreadable store file: ${file}`);
		}
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

// ---------------------------------------------------------------------------
// Repository identity and HEAD (filesystem only; no git process)
// ---------------------------------------------------------------------------

export interface GitLocation {
	toplevel: string;
	gitDir: string;
}

export async function readText(fsx: HookFs, file: string, cap: number): Promise<string | null> {
	try {
		return (await readCapped(fsx, file, cap)).toString("utf8");
	} catch (error) {
		if (errCode(error) === "ENOENT") return null;
		throw error;
	}
}

/** Walk up from `cwd` (at most 64 levels) to the nearest `.git` directory or `gitdir:` file. */
export async function findGitLocation(fsx: HookFs, cwd: string): Promise<GitLocation | null> {
	let dir = path.resolve(cwd);
	for (let level = 0; level < MAX_GITDIR_LEVELS; level++) {
		const candidate = path.join(dir, ".git");
		const st = await fsx.lstat(candidate).catch((error: unknown) => {
			if (errCode(error) === "ENOENT" || errCode(error) === "ENOTDIR") return null;
			throw error;
		});
		if (st?.isDirectory()) return { toplevel: dir, gitDir: candidate };
		if (st?.isFile()) {
			const text = await readText(fsx, candidate, HEAD_READ_CAP);
			const match = text?.match(/^gitdir:\s*(.+?)\s*$/m);
			if (match?.[1]) return { toplevel: dir, gitDir: path.resolve(dir, match[1]) };
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Launch listing parser and prompt text (inline constants: documented AGENTS.md exception, README D9)
// ---------------------------------------------------------------------------

export interface ParsedLaunch {
	expected: number | null;
	/** subagent id + job id pairs in listing order (async job always present). */
	jobs: Array<{ subagentId: string; jobId: string }>;
	complete: boolean;
}

export function parseLaunchText(text: unknown, asyncJobId: string): ParsedLaunch {
	const partial: ParsedLaunch = {
		expected: null,
		jobs: [{ subagentId: asyncJobId, jobId: asyncJobId }],
		complete: false,
	};
	if (typeof text !== "string") return partial;
	const head = text.length > PARSE_TEXT_BYTES ? text.slice(0, PARSE_TEXT_BYTES) : text;
	const first = head.match(/^Started ([0-9]{1,3}) background task jobs? using /);
	const lines: Array<{ subagentId: string; jobId: string }> = [];
	for (const line of head.split("\n")) {
		const m = line.match(/^- `([^`\n]{1,256})` \(job `([^`\n]{1,256})`\)/);
		if (m?.[1] && m[2] && m[1].length <= MAX_ID_CHARS && m[2].length <= MAX_ID_CHARS) {
			lines.push({ subagentId: m[1], jobId: m[2] });
			if (lines.length > MAX_JOB_LINES) break;
		}
	}
	if (!first?.[1]) return partial;
	const expected = Number(first[1]);
	// Model-authored descriptions can carry fake listing lines: a duplicate job id, or padding that pushes the real
	// lines past the parsed window, must only ever make the set partial, never complete.
	const unique = new Set(lines.map(l => l.jobId)).size === lines.length;
	const complete =
		expected >= 1 &&
		expected <= MAX_JOB_LINES &&
		text.length <= PARSE_TEXT_BYTES &&
		unique &&
		lines.length === expected &&
		lines.some(l => l.jobId === asyncJobId);
	if (complete) return { expected, jobs: lines, complete: true };
	const jobs = lines.filter((l, i) => lines.findIndex(o => o.jobId === l.jobId) === i).slice(0, MAX_JOB_LINES);
	if (!jobs.some(j => j.jobId === asyncJobId)) jobs.push({ subagentId: asyncJobId, jobId: asyncJobId });
	return { expected, jobs: jobs.slice(0, MAX_JOB_LINES), complete: false };
}

export interface LaunchTextInput {
	gateId8: string;
	jobs: number;
	complete: boolean;
	baseline: "before_hook" | "none";
	isolated: boolean;
	recorded: boolean;
}

export function buildLaunchText(input: LaunchTextInput): string {
	const lines = [
		`[delegation-verification-gate] gate=${input.gateId8} trigger=task_launch jobs=${input.jobs} job_set=${input.complete ? "complete" : "partial"} baseline=${input.baseline} isolated=${input.isolated ? "yes" : "no"} ledger=${input.recorded ? "recorded" : "unrecorded"}`,
		"after the delegated work finishes (auto-delivered result, `subagent` await, or `job` poll): call verification_loop with no parameters and resolve every gap; use verification_run on explicit test files covering the change.",
	];
	if (!input.complete) {
		lines.push("after all delegated work finishes, call `job` with list: true so the gate can observe quiescence.");
	}
	lines.push(
		"judgment (not checked mechanically): do the tests exercise the change? were failures fixed rather than skipped? does the summary match the diff?",
		"advisory gate, not a block; clean is a mechanical recheck, not proof.",
	);
	return lines.join("\n").slice(0, LAUNCH_TEXT_MAX);
}

export function buildReminderText(gateId8: string, terminal: number, total: number): string {
	return `[delegation-verification-gate] gate=${gateId8} terminal=${terminal}/${total}: call verification_loop before relying on this delegated work.`.slice(
		0,
		REMINDER_TEXT_MAX,
	);
}

// ---------------------------------------------------------------------------
// Event store (hooks write, the loop merges)
// ---------------------------------------------------------------------------

export type EventKind = "baseline" | "launch" | "subagent" | "job" | "quiescence" | "snapshot";
export const EVENT_FILE = /^(\d{13})-(baseline|launch|subagent|job|quiescence|snapshot)-([0-9a-f]{8})\.json$/;
export const MARKER_FILE = /^(OVERFLOW|DROP)-(\d{13})-([0-9a-f]{8})$/;

export interface SessionIdentity {
	repoDigest: string;
	sessionDigest: string;
	toplevel: string;
}

export function eventsParts(repoDigest: string, sessionDigest: string): string[] {
	return ["events", "v1", repoDigest, sessionDigest];
}

function epoch13(ms: number): string {
	return String(Math.max(0, Math.trunc(ms))).padStart(13, "0");
}
function rand8(): string {
	return crypto.randomBytes(4).toString("hex");
}

export async function identify(deps: HookDeps, ctx: HookCtx): Promise<SessionIdentity | null> {
	const location = await findGitLocation(deps.fs, ctx.cwd);
	if (!location) return null;
	const toplevel = await deps.fs.realpath(location.toplevel);
	return {
		toplevel,
		repoDigest: sha256Hex(toplevel),
		sessionDigest: sha256Hex(ctx.sessionManager.getSessionId()),
	};
}

export async function writeMarker(deps: HookDeps, dir: string, kind: "DROP" | "OVERFLOW"): Promise<void> {
	await writeNew(deps.fs, path.join(dir, `${kind}-${epoch13(deps.now())}-${rand8()}`), "");
}

/** Returns true when the event is durably created. Any failure leaves a DROP marker (best effort). */
export async function recordEvent(
	deps: HookDeps,
	identity: SessionIdentity | null,
	kind: EventKind,
	payload: Record<string, unknown>,
): Promise<boolean> {
	if (!deps.storeRoot || !identity) return false;
	let dir: string | null = null;
	try {
		dir = await ensureChain(deps.fs, deps.storeRoot, eventsParts(identity.repoDigest, identity.sessionDigest), true);
		if (!dir) return false;
		if ((await deps.fs.readdir(dir)).length >= MAX_EVENT_FILES) {
			await writeMarker(deps, dir, "OVERFLOW");
			return false;
		}
		const body = JSON.stringify({ v: 1, kind, ...payload });
		if (Buffer.byteLength(body) > MAX_EVENT_BYTES) throw new StoreError("store_corrupt", "event too large");
		await writeNew(deps.fs, path.join(dir, `${epoch13(deps.now())}-${kind}-${rand8()}.json`), body);
		return true;
	} catch (error) {
		deps.logger?.warn("verification-receipts: hook event dropped", { kind, error: String(error) });
		if (dir) await writeMarker(deps, dir, "DROP").catch(() => undefined);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Shared data contracts: fingerprint and receipt shapes (pure; validated on every load)
// ---------------------------------------------------------------------------

export type GitSubreason = "git_timeout" | "git_output_limit" | "git_failed" | "spawn_failed";
export type FingerprintReason =
	| "observed_source"
	| "git_unavailable"
	| "unsafe_root"
	| "unsupported_config"
	| "invalid_index"
	| "submodule_dirty"
	| "unsupported_file"
	| "symlink_parent"
	| "source_unreadable"
	| "selected_input_unavailable"
	| "unsafe_selected_input"
	| "file_limit"
	| "byte_limit"
	| "changed_while_hashing";
export interface FingerprintCounts {
	indexEntries: number;
	dirtyPaths: number;
	hashedBytes: number;
}
export interface SourceFingerprint {
	status: "available" | "unavailable";
	reason: FingerprintReason;
	subreason: GitSubreason | null;
	head: string | null;
	sourceDigest: string | null;
	selectedDigest: string | null;
	digest: string | null;
	counts: FingerprintCounts;
}

export type Freshness = "fresh" | "stale" | "changed_during_run" | "unavailable";

export type ExecutionStatus = "passed" | "failed" | "no_tests" | "incomplete" | "not_run" | "unavailable";
export interface ExecCounts {
	tests: number;
	passed: number;
	failed: number;
	errors: number;
	skipped: number;
}
export interface Execution {
	status: ExecutionStatus;
	reason: string;
	exitCode: number | null;
	signal: string | null;
	counts: ExecCounts | null;
	perInput: ExecCounts[] | null;
	outputBytes: number;
}
export interface Receipt {
	schemaVersion: 1;
	plugin: string;
	pluginVersion: string;
	id: string;
	runner: "bun-test" | "node-test";
	runnerVersion: string;
	repositoryDigest: string;
	toolCallDigest: string;
	sessionDigest: string;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	specDigest: string;
	selectedInputs: string[];
	before: SourceFingerprint;
	after: SourceFingerprint;
	freshness: Freshness;
	execution: Execution;
	advisoryOnly: true;
	limitations: string[];
}
export interface ReceiptEnvelope {
	storageSchemaVersion: 1;
	inputDigest: string;
	receipt: Receipt;
}

export const RECEIPT_MAX_BYTES = 32 * 1024;
export const RECEIPTS_PER_REPO = 200;
export const RECEIPT_BYTES_PER_REPO = 8 * 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function envelopeOf(receipt: Receipt): ReceiptEnvelope {
	return { storageSchemaVersion: 1, inputDigest: sha256Hex(canonicalJson(receipt)), receipt };
}

const sameKeys = (value: object, keys: readonly string[]): boolean => {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && [...keys].sort().every((k, i) => k === actual[i]);
};
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sumOf = (c: ExecCounts[], key: keyof ExecCounts): number => c.reduce((n, x) => n + x[key], 0);

function validCounts(c: unknown): c is ExecCounts {
	return (
		isRec(c) &&
		sameKeys(c, ["tests", "passed", "failed", "errors", "skipped"]) &&
		Object.values(c).every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100_000)
	);
}
function validFingerprint(f: unknown): f is SourceFingerprint {
	if (
		!isRec(f) ||
		!sameKeys(f, ["status", "reason", "subreason", "head", "sourceDigest", "selectedDigest", "digest", "counts"])
	)
		return false;
	if (f.status !== "available" && f.status !== "unavailable") return false;
	const digests = [f.sourceDigest, f.selectedDigest, f.digest];
	const okDigest = (d: unknown): boolean =>
		f.status === "available" ? typeof d === "string" && HEX64.test(d) : d === null;
	return (
		digests.every(okDigest) && isRec(f.counts) && sameKeys(f.counts, ["indexEntries", "dirtyPaths", "hashedBytes"])
	);
}

/** Load validation: exact keys, hex digests, uuid == file name, recomputed `inputDigest`, passed-rule. */
export function validateEnvelope(value: unknown, fileId: string): Receipt | null {
	if (
		!isRec(value) ||
		!sameKeys(value, ["storageSchemaVersion", "inputDigest", "receipt"]) ||
		value.storageSchemaVersion !== 1
	)
		return null;
	const r = value.receipt;
	const keys = [
		"schemaVersion",
		"plugin",
		"pluginVersion",
		"id",
		"runner",
		"runnerVersion",
		"repositoryDigest",
		"toolCallDigest",
		"sessionDigest",
		"startedAt",
		"finishedAt",
		"durationMs",
		"specDigest",
		"selectedInputs",
		"before",
		"after",
		"freshness",
		"execution",
		"advisoryOnly",
		"limitations",
	];
	if (!isRec(r) || !sameKeys(r, keys) || r.id !== fileId || !isUuid(r.id)) return null;
	if (value.inputDigest !== sha256Hex(canonicalJson(r))) return null;
	if (r.schemaVersion !== 1 || r.plugin !== PLUGIN_NAME || r.advisoryOnly !== true) return null;
	if (r.runner !== "bun-test" && r.runner !== "node-test") return null;
	for (const k of ["repositoryDigest", "toolCallDigest", "sessionDigest", "specDigest"]) {
		if (typeof r[k] !== "string" || !HEX64.test(r[k] as string)) return null;
	}
	if (!Array.isArray(r.selectedInputs) || r.selectedInputs.length < 1 || r.selectedInputs.length > 32) return null;
	if (!Array.isArray(r.limitations) || r.limitations.length > 20) return null;
	if (!validFingerprint(r.before) || !validFingerprint(r.after)) return null;
	const e = r.execution;
	if (!isRec(e) || !sameKeys(e, ["status", "reason", "exitCode", "signal", "counts", "perInput", "outputBytes"]))
		return null;
	const n = r.selectedInputs.length;
	if (e.perInput !== null) {
		if (!Array.isArray(e.perInput) || e.perInput.length !== n || !e.perInput.every(validCounts)) return null;
		if (!validCounts(e.counts)) return null;
		for (const key of ["tests", "passed", "failed", "errors", "skipped"] as const) {
			if (sumOf(e.perInput, key) !== e.counts[key]) return null;
		}
	}
	if (e.status === "passed") {
		const c = e.counts;
		if (
			!validCounts(c) ||
			e.exitCode !== 0 ||
			e.signal !== null ||
			c.tests <= 0 ||
			c.passed <= 0 ||
			c.failed + c.errors !== 0
		)
			return null;
		if (!Array.isArray(e.perInput) || e.perInput.some((p: ExecCounts) => p.tests - p.skipped < 1)) return null;
	}
	return r as unknown as Receipt;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const TIMED_OUT = Symbol("timed-out");

export async function withBudget<T>(deps: HookDeps, work: Promise<T>): Promise<T | typeof TIMED_OUT> {
	work.catch(() => undefined);
	return await Promise.race([work, deps.sleep(deps.budgetMs).then((): typeof TIMED_OUT => TIMED_OUT)]);
}

export function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref?.();
	return promise;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
export function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS ? value : null;
}

/** toolCallId -> head sha observed by the baseline hook (bounded, in-process, for launch-text wording only). */
export const baselineHeads = new Map<string, string | null>();
export const BASELINE_MEMORY_CAP = 256;

interface GateMemory {
	total: number;
	terminal: Set<string>;
}
const gateMemory = new Map<string, GateMemory>();
const gateByJob = new Map<string, string>();
const GATE_MEMORY_CAP = 256;

function remember(gateId8: string, jobDs: string[]): void {
	if (gateMemory.size >= GATE_MEMORY_CAP) {
		const oldest = gateMemory.keys().next().value as string;
		gateMemory.delete(oldest);
		for (const [job, gate] of gateByJob) if (gate === oldest) gateByJob.delete(job);
	}
	gateMemory.set(gateId8, { total: jobDs.length, terminal: new Set() });
	for (const jobD of jobDs) gateByJob.set(jobD, gateId8);
}

function reminderFor(observed: Array<{ jobD: string; status: string }>): TextBlock | null {
	for (const { jobD, status } of observed) {
		const gate8 = gateByJob.get(jobD);
		const memory = gate8 ? gateMemory.get(gate8) : undefined;
		if (!gate8 || !memory || !TERMINAL_STATUSES.has(status)) continue;
		memory.terminal.add(jobD);
		return { type: "text", text: buildReminderText(gate8, memory.terminal.size, memory.total) };
	}
	return null;
}

function withExtraText(event: HookToolEvent, block: TextBlock): { content: unknown[] } {
	return { content: [...(Array.isArray(event.content) ? event.content : []), block] };
}

async function handleTask(
	deps: HookDeps,
	event: HookToolEvent,
	ctx: HookCtx,
): Promise<{ content: unknown[] } | undefined> {
	if (event.isError === true) return undefined;
	const details = asRecord(event.details);
	const asyncInfo = asRecord(details?.async);
	const jobId = asString(asyncInfo?.jobId);
	const toolCallId = asString(event.toolCallId);
	if (asyncInfo?.state !== "running" || !jobId || !toolCallId) return undefined;
	const content = Array.isArray(event.content) ? event.content : [];
	const text = asRecord(content[0])?.text;
	const parsed = parseLaunchText(text, jobId);
	const key = taskGateKey(toolCallId);
	const gateId = gateIdOf(key);
	const toolCallAt = deps.now();
	const identity = await identify(deps, ctx).catch(() => null);
	const baselineHead = baselineHeads.get(toolCallId);
	const isolated = asRecord(event.input)?.isolated === true;
	const recorded = await recordEvent(deps, identity, "launch", {
		key,
		toolCallD: d16(toolCallId),
		toolCallAt,
		isolated,
		expected: parsed.expected,
		complete: parsed.complete,
		jobs: parsed.jobs.map(j => [d16(j.jobId), d16(j.subagentId)]),
	});
	remember(
		gateId.slice(0, 8),
		parsed.jobs.map(j => d16(j.jobId)),
	);
	return withExtraText(event, {
		type: "text",
		text: buildLaunchText({
			gateId8: gateId.slice(0, 8),
			jobs: parsed.jobs.length,
			complete: parsed.complete,
			baseline: typeof baselineHead === "string" ? "before_hook" : "none",
			isolated,
			recorded,
		}),
	});
}

export type SubagentItem = [jobD: string, subD: string, status: string];
export type JobItem = [jobD: string, type: "task" | "other", status: string];

/** `d16(toolCallId)`, or null when the id is absent/oversized (never a digest of the empty string). */
export function toolCallDigest(id: unknown): string | null {
	const text = asString(id);
	return text ? d16(text) : null;
}

/** The single extractor for `subagent` result facts: used by the hook handler and the transcript walk. */
export function subagentItems(details: unknown): SubagentItem[] {
	const list = asRecord(details)?.subagents;
	const items: SubagentItem[] = [];
	for (const raw of Array.isArray(list) ? list.slice(0, MAX_JOB_LINES) : []) {
		const rec = asRecord(raw);
		const id = asString(rec?.id);
		const jobId = asString(rec?.jobId);
		if (id && jobId) items.push([d16(jobId), d16(id), normalizeStatus(rec?.status)]);
	}
	return items;
}

/**
 * The single extractor for `job` result facts (hook handler and transcript walk): `jobs[]` items are typed by
 * their own `type`, `cancelled[]` items are task jobs. `activeTaskJob` covers every listed non-terminal task job
 * and fails closed (true) when the list is truncated or a task item cannot be parsed. `listed` is true only when
 * `jobs` is an array, so an empty listing can still prove quiescence.
 */
export function jobItems(details: unknown): { items: JobItem[]; activeTaskJob: boolean; listed: boolean } {
	const rec = asRecord(details);
	const items: JobItem[] = [];
	const listed = Array.isArray(rec?.jobs);
	const jobs: unknown[] = listed ? (rec?.jobs as unknown[]) : [];
	let activeTaskJob = jobs.length > 4 * MAX_JOB_LINES;
	for (const raw of jobs.slice(0, 4 * MAX_JOB_LINES)) {
		const job = asRecord(raw);
		const id = asString(job?.id);
		const type = job?.type === "task" ? "task" : "other";
		const status = normalizeStatus(job?.status);
		if (!id) {
			if (job?.type === "task" || !job) activeTaskJob = true;
			continue;
		}
		if (type === "task" && !TERMINAL_STATUSES.has(status)) activeTaskJob = true;
		if (items.length < 2 * MAX_JOB_LINES) items.push([d16(id), type, status]);
	}
	for (const raw of Array.isArray(rec?.cancelled) ? rec.cancelled.slice(0, MAX_JOB_LINES / 2) : []) {
		const job = asRecord(raw);
		const id = asString(job?.id);
		if (id) items.push([d16(id), "task", normalizeStatus(job?.status)]);
	}
	return { items, activeTaskJob, listed };
}

async function handleSubagent(
	deps: HookDeps,
	event: HookToolEvent,
	ctx: HookCtx,
): Promise<{ content: unknown[] } | undefined> {
	if (event.isError === true) return undefined;
	const items = subagentItems(event.details);
	if (items.length === 0) return undefined;
	const identity = await identify(deps, ctx).catch(() => null);
	await recordEvent(deps, identity, "subagent", {
		at: deps.now(),
		toolCallD: toolCallDigest(event.toolCallId),
		items,
	});
	const block = reminderFor(items.map(([jobD, , status]) => ({ jobD, status })));
	return block ? withExtraText(event, block) : undefined;
}

async function handleJob(
	deps: HookDeps,
	event: HookToolEvent,
	ctx: HookCtx,
): Promise<{ content: unknown[] } | undefined> {
	if (event.isError === true) return undefined;
	const { items, activeTaskJob, listed } = jobItems(event.details);
	const quiescent = asRecord(event.input)?.list === true && listed && !activeTaskJob;
	if (items.length === 0 && !quiescent) return undefined;
	const identity = await identify(deps, ctx).catch(() => null);
	const at = deps.now();
	if (items.length > 0) await recordEvent(deps, identity, "job", { at, items });
	if (quiescent) await recordEvent(deps, identity, "quiescence", { at });
	const block = reminderFor(items.map(([jobD, , status]) => ({ jobD, status })));
	return block ? withExtraText(event, block) : undefined;
}

export function createGateHandler(
	deps: HookDeps,
): (event: HookToolEvent, ctx: HookCtx) => Promise<{ content: unknown[] } | undefined> {
	return async (event, ctx) => {
		try {
			const tool = event.toolName;
			const work =
				tool === "task"
					? handleTask(deps, event, ctx)
					: tool === "subagent"
						? handleSubagent(deps, event, ctx)
						: tool === "job"
							? handleJob(deps, event, ctx)
							: Promise.resolve(undefined);
			const outcome = await withBudget(deps, work);
			return outcome === TIMED_OUT ? undefined : outcome;
		} catch (error) {
			deps.logger?.warn("verification-receipts: gate hook failed", { error: String(error) });
			return undefined;
		}
	};
}

/** Resolve deps for an installed hook. A project-scope or uninstalled layout never writes. */
export function hookDepsFromLayout(dir: string, budgetMs: number, logger: HookLogger | undefined): HookDeps {
	const resolution = resolveStoreRoot(dir);
	return {
		fs,
		now: () => Date.now(),
		sleep: defaultSleep,
		budgetMs,
		storeRoot: resolution.ok ? resolution.storeRoot : null,
		logger,
	};
}

interface HookApi {
	on(event: string, handler: (...args: never[]) => unknown): void;
	logger?: HookLogger;
}

/** Default export: registers exactly one `tool_result` handler (the host filters by declared target). */
export default function registerVerificationGate(api: HookApi): void {
	api.on("tool_result", createGateHandler(hookDepsFromLayout(import.meta.dir, GATE_BUDGET_MS, api.logger)));
}
