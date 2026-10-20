/**
 * verification-receipts: `tool_call`/`task`/before baseline hook.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin
 * `verification-receipts` (MIT, Copyright (c) 2026 jjongguet). See NOTICE.md and LICENSE.gjc-plugin.
 *
 * Records the repository HEAD (read from the filesystem, no git process) before a delegation starts.
 * Always resolves to `undefined`: it never blocks or alters the tool call.
 *
 * This module also hosts the advisory file lock used by the tools (kept here, not in the shared hook core,
 * so the core stays within its size budget; the lock never signals processes, liveness is injected).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	asRecord,
	asString,
	BASELINE_BUDGET_MS,
	BASELINE_MEMORY_CAP,
	baselineHeads,
	d16,
	defaultSleep,
	ensureChain,
	errCode,
	eventsParts,
	findGitLocation,
	gateIdOf,
	HEAD_READ_CAP,
	type HookCtx,
	type HookDeps,
	type HookFs,
	type HookLogger,
	type HookToolEvent,
	hookDepsFromLayout,
	identify,
	jobItems,
	normalizeStatus,
	parseLaunchText,
	readText,
	recordEvent,
	StoreError,
	subagentItems,
	TIMED_OUT,
	taskGateKey,
	toolCallDigest,
	withBudget,
	writeMarker,
} from "./verification-gate";

const PACKED_REFS_CAP = 4 * 1024 * 1024;
export const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---------------------------------------------------------------------------
// Advisory file locks (tools only; the hooks never take a lock)
// ---------------------------------------------------------------------------

export class StoreBusyError extends Error {}

export interface LockOptions {
	/** Liveness probe for the recorded pid; injected so this module never signals processes. */
	pidAlive: (pid: number) => boolean;
	waitMs?: number;
	staleMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Test seam: runs between reading a stale lock and unlinking it. */
	beforeBreak?: () => Promise<void>;
}

interface LockBody {
	v: 1;
	pid: number;
	createdAt: number;
	nonce: string;
}

async function readLockBody(fsx: HookFs, file: string): Promise<{ body: LockBody | null; mtimeMs: number } | null> {
	try {
		const handle = await fsx.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const st = await handle.stat();
			if (!st.isFile() || st.size > 4096) return { body: null, mtimeMs: st.mtimeMs };
			const parsed = asRecord(JSON.parse((await handle.readFile()).toString("utf8")));
			const ok =
				parsed?.v === 1 &&
				typeof parsed.pid === "number" &&
				typeof parsed.createdAt === "number" &&
				typeof parsed.nonce === "string";
			return { body: ok ? (parsed as unknown as LockBody) : null, mtimeMs: st.mtimeMs };
		} catch {
			return { body: null, mtimeMs: (await handle.stat()).mtimeMs };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (errCode(error) === "ENOENT") return null;
		throw error;
	}
}

/** O_EXCL lock file `{v, pid, createdAt, nonce}`; stale = dead pid or age > staleMs; breaks are nonce-checked. */
export async function withLock<T>(fsx: HookFs, file: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;
	const staleMs = opts.staleMs ?? 60_000;
	const deadline = now() + (opts.waitMs ?? 1000);
	const nonce = crypto.randomBytes(8).toString("hex");
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	for (;;) {
		try {
			const handle = await fsx.open(file, flags, 0o600);
			try {
				await handle.writeFile(JSON.stringify({ v: 1, pid: process.pid, createdAt: now(), nonce }));
			} finally {
				await handle.close();
			}
			break;
		} catch (error) {
			if (errCode(error) !== "EEXIST") throw error;
		}
		if (now() >= deadline) throw new StoreBusyError(`lock busy: ${file}`);
		const held = await readLockBody(fsx, file);
		if (held === null) continue;
		const stale = held.body
			? !opts.pidAlive(held.body.pid) || now() - held.body.createdAt > staleMs
			: now() - held.mtimeMs > staleMs;
		if (stale) {
			await opts.beforeBreak?.();
			const again = await readLockBody(fsx, file);
			if (again && again.body?.nonce === held.body?.nonce && (again.body !== null || held.body === null)) {
				await fsx.unlink(file).catch((error: unknown) => {
					if (errCode(error) !== "ENOENT") throw error;
				});
				continue;
			}
		}
		await sleep(25 + Math.floor(Math.random() * 50));
	}
	try {
		return await fn();
	} finally {
		const mine = await readLockBody(fsx, file).catch(() => null);
		if (mine?.body?.nonce === nonce) await fsx.unlink(file).catch(() => undefined);
	}
}

/** HEAD commit sha from HEAD, loose refs, packed-refs and `commondir`; null when unborn. */
export async function readHeadSha(fsx: HookFs, gitDir: string): Promise<string | null> {
	const head = (await readText(fsx, path.join(gitDir, "HEAD"), HEAD_READ_CAP))?.trim();
	if (head === undefined) throw new StoreError("store_corrupt", "missing HEAD");
	const refMatch = head.match(/^ref:\s*(\S+)$/);
	if (!refMatch?.[1]) {
		if (!HEX_SHA.test(head)) throw new StoreError("store_corrupt", "unrecognized HEAD");
		return head;
	}
	const ref = refMatch[1];
	if (!ref.startsWith("refs/") || ref.split("/").includes("..")) throw new StoreError("store_corrupt", "unsafe ref");
	let commonDir = gitDir;
	const commonText = (await readText(fsx, path.join(gitDir, "commondir"), 4096))?.trim();
	if (commonText) commonDir = path.resolve(gitDir, commonText);
	const loose = (await readText(fsx, path.join(commonDir, ref), 1024))?.trim();
	if (loose !== undefined) {
		if (!HEX_SHA.test(loose)) throw new StoreError("store_corrupt", "unrecognized loose ref");
		return loose;
	}
	const packed = await readText(fsx, path.join(commonDir, "packed-refs"), PACKED_REFS_CAP);
	if (packed === null) return null;
	for (const line of packed.split("\n")) {
		const parts = line.split(" ");
		if (parts.length === 2 && parts[1] === ref && HEX_SHA.test(parts[0] ?? "")) return parts[0] ?? null;
	}
	return null;
}

export function createBaselineHandler(deps: HookDeps): (event: HookToolEvent, ctx: HookCtx) => Promise<undefined> {
	return async (event, ctx) => {
		try {
			const baselineAt = deps.now();
			const toolCallId = asString(event.toolCallId);
			if (!toolCallId) return undefined;
			const work = (async () => {
				const identity = await identify(deps, ctx);
				const location = await findGitLocation(deps.fs, ctx.cwd);
				if (!identity || !location) return;
				const head = await readHeadSha(deps.fs, location.gitDir);
				if (baselineHeads.size >= BASELINE_MEMORY_CAP)
					baselineHeads.delete(baselineHeads.keys().next().value as string);
				baselineHeads.set(toolCallId, head);
				const recorded = await recordEvent(deps, identity, "baseline", {
					toolCallD: d16(toolCallId),
					head,
					baselineAt,
					source: "hook_fs",
				});
				if (!recorded) throw new StoreError("store_corrupt", "baseline event not recorded");
			})();
			const outcome = await withBudget(deps, work);
			if (outcome === TIMED_OUT) deps.logger?.warn("verification-receipts: baseline timed out");
		} catch (error) {
			deps.logger?.warn("verification-receipts: baseline failed", { error: String(error) });
			await dropMarker(deps, ctx).catch(() => undefined);
		}
		return undefined;
	};
}

async function dropMarker(deps: HookDeps, ctx: HookCtx): Promise<void> {
	if (!deps.storeRoot) return;
	const identity = await identify(deps, ctx);
	if (!identity) return;
	const dir = await ensureChain(
		deps.fs,
		deps.storeRoot,
		eventsParts(identity.repoDigest, identity.sessionDigest),
		true,
	);
	if (dir) await writeMarker(deps, dir, "DROP");
}

// ---------------------------------------------------------------------------
// Shared gate model (pure; consumed by verification_loop and evaluateGates)
// ---------------------------------------------------------------------------

export const WALK_MS = 5000;
export const LEDGER_MAX = 512 * 1024;
export const FLOOR_SLACK_MS = 2000;
const MODULE_LOADED_AT = Date.now();
const HEX16 = /^[0-9a-f]{16}$/;

export const GAP_KINDS = [
	"delegation_terminal_unobserved",
	"delegation_job_set_partial",
	"no_receipt_after_terminal",
	"receipt_not_passed",
	"receipt_no_tests",
	"receipt_incomplete",
	"receipt_changed_during_run",
	"receipt_freshness_unavailable",
	"receipt_stale",
	"changed_test_uncovered",
	"changed_set_unavailable",
	"gate_state_dropped",
	"scan_truncated",
	"budget_exhausted",
] as const;
export type GapKind = (typeof GAP_KINDS)[number];
export const TERMINAL: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"already_completed",
	"inferred",
	"completed_or_failed",
]);

export type JobTuple = [
	jobD: string,
	subagentD: string,
	state: string,
	terminal: 0 | 1,
	terminalAt: number | null,
	source: "subagent" | "job" | "async_result",
];
export interface OpenGate {
	id: string;
	key: string;
	trigger: "task_launch" | "subagent_resume" | "discovered";
	origin: "hook" | "transcript";
	openedAt: number;
	toolCallAt: number;
	baselineHead: string | null;
	baselineSource: "before_hook" | "prior_observation" | "none";
	baselineAt: number | null;
	subagentDigest: string | null;
	priorJobDigest: string | null;
	expectedJobs: number | null;
	jobSetComplete: boolean;
	quiescentAt: number | null;
	isolated: boolean;
	lastGapMask: number;
	loopRuns: number;
	jobs: JobTuple[];
	subState: string | null;
	subStateAt: number | null;
}
export interface ResolvedGate extends Omit<OpenGate, "jobs" | "subState" | "subStateAt"> {
	jobCount: number;
	resolvedAt: number;
	resolution: "no_change" | "receipts";
	resolvedReceiptIds: string[];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type StoredGate = OpenGate | ResolvedGate;
export const isOpen = (g: StoredGate): g is OpenGate => "jobs" in g;

export interface Ledger {
	schemaVersion: 1;
	repoDigest: string;
	sessionDigest: string;
	createdAt: number;
	updatedAt: number;
	activationAt: number;
	scan: {
		floor: number;
		cursor: { entryId: string; entryTimestamp: number } | null;
		pending: { topId: string; bottomId: string } | null;
		truncatedAt: number | null;
	};
	overflow: { firstAt: number; lastAt: number; pendingKeys: string[]; keysTruncated: boolean } | null;
	retiredKeys: string[];
	headObservations: Array<{ at: number; head: string | null; source: "hook_fs" | "tool_git" }>;
	sourceSnapshots: Array<{ at: number; sourceDigest: string; head: string | null; by: "run" | "status" | "loop" }>;
	baselines: Array<[toolCallD: string, head: string | null, baselineAt: number]>;
	gates: StoredGate[];
}

export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const isHex16 = (v: unknown): v is string => typeof v === "string" && HEX16.test(v);
export const isHead = (v: unknown): v is string | null => v === null || (typeof v === "string" && HEX_SHA.test(v));
export const KEY = /^(?:(?:task|job):[0-9a-f]{16}|resume:[0-9a-f]{16}:[0-9a-f]{16})$/;
export const SOURCES = new Set(["subagent", "job", "async_result"]);

export function validTuple(t: unknown): t is JobTuple {
	return (
		Array.isArray(t) &&
		t.length === 6 &&
		isHex16(t[0]) &&
		(t[1] === "" || isHex16(t[1])) &&
		typeof t[2] === "string" &&
		t[2].length <= 32 &&
		(t[3] === 0 || t[3] === 1) &&
		(t[4] === null || isInt(t[4])) &&
		SOURCES.has(String(t[5]))
	);
}

export function validGate(v: unknown): StoredGate | null {
	const g = asRecord(v);
	if (!g || !isHex16(g.id) || typeof g.key !== "string" || !KEY.test(g.key) || gateIdOf(g.key) !== g.id) return null;
	const ok =
		["task_launch", "subagent_resume", "discovered"].includes(String(g.trigger)) &&
		["hook", "transcript"].includes(String(g.origin)) &&
		isInt(g.openedAt) &&
		isInt(g.toolCallAt) &&
		isHead(g.baselineHead) &&
		["before_hook", "prior_observation", "none"].includes(String(g.baselineSource)) &&
		(g.baselineAt === null || isInt(g.baselineAt)) &&
		(g.subagentDigest === null || isHex16(g.subagentDigest)) &&
		(g.priorJobDigest === null || isHex16(g.priorJobDigest)) &&
		(g.expectedJobs === null || isInt(g.expectedJobs)) &&
		typeof g.jobSetComplete === "boolean" &&
		(g.quiescentAt === null || isInt(g.quiescentAt)) &&
		typeof g.isolated === "boolean" &&
		isInt(g.lastGapMask) &&
		isInt(g.loopRuns);
	if (!ok) return null;
	if ("jobs" in g) {
		const jobs = g.jobs;
		const subOk = g.subState === null || typeof g.subState === "string";
		const atOk = g.subStateAt === null || isInt(g.subStateAt);
		return Array.isArray(jobs) && jobs.length <= 64 && jobs.every(validTuple) && subOk && atOk
			? (g as unknown as OpenGate)
			: null;
	}
	const resolvedOk =
		isInt(g.jobCount) &&
		isInt(g.resolvedAt) &&
		(g.resolution === "no_change" || g.resolution === "receipts") &&
		Array.isArray(g.resolvedReceiptIds) &&
		g.resolvedReceiptIds.length <= 8;
	return resolvedOk ? (g as unknown as ResolvedGate) : null;
}

export function validateLedger(raw: unknown, repoDigest: string, sessionDigest: string): Ledger | null {
	const l = asRecord(raw);
	const scan = asRecord(l?.scan);
	if (!l || !scan || l.schemaVersion !== 1 || l.repoDigest !== repoDigest || l.sessionDigest !== sessionDigest)
		return null;
	if (!isInt(l.createdAt) || !isInt(l.updatedAt) || !isInt(l.activationAt) || !isInt(scan.floor)) return null;
	const cursor = asRecord(scan.cursor);
	const pending = asRecord(scan.pending);
	if (scan.cursor !== null && !(cursor && typeof cursor.entryId === "string" && isInt(cursor.entryTimestamp)))
		return null;
	if (scan.pending !== null && !(pending && typeof pending.topId === "string" && typeof pending.bottomId === "string"))
		return null;
	if (scan.truncatedAt !== null && !isInt(scan.truncatedAt)) return null;
	const ov = asRecord(l.overflow);
	if (l.overflow !== null) {
		const keys = ov?.pendingKeys;
		if (!ov || !isInt(ov.firstAt) || !isInt(ov.lastAt) || typeof ov.keysTruncated !== "boolean") return null;
		if (!Array.isArray(keys) || keys.length > 256 || !keys.every(k => typeof k === "string" && KEY.test(k)))
			return null;
	}
	const rings = [l.retiredKeys, l.headObservations, l.sourceSnapshots, l.baselines, l.gates];
	if (!rings.every(Array.isArray)) return null;
	if (
		(l.retiredKeys as unknown[]).length > 512 ||
		!(l.retiredKeys as unknown[]).every(k => typeof k === "string" && KEY.test(k))
	)
		return null;
	const heads = l.headObservations as unknown[];
	if (heads.length > 32 || !heads.every(h => isInt(asRecord(h)?.at) && isHead(asRecord(h)?.head))) return null;
	const snaps = l.sourceSnapshots as unknown[];
	if (snaps.length > 32 || !snaps.every(s => isInt(asRecord(s)?.at) && typeof asRecord(s)?.sourceDigest === "string"))
		return null;
	const bases = l.baselines as unknown[];
	if (bases.length > 64 || !bases.every(b => Array.isArray(b) && isHex16(b[0]) && isHead(b[1]) && isInt(b[2])))
		return null;
	const gates = (l.gates as unknown[]).map(validGate);
	if (gates.length > 128 || gates.some(g => g === null)) return null;
	return { ...(l as unknown as Ledger), gates: gates as StoredGate[] };
}

export function newLedger(repoDigest: string, sessionDigest: string, now: number): Ledger {
	return {
		schemaVersion: 1,
		repoDigest,
		sessionDigest,
		createdAt: now,
		updatedAt: now,
		activationAt: MODULE_LOADED_AT,
		scan: { floor: MODULE_LOADED_AT - FLOOR_SLACK_MS, cursor: null, pending: null, truncatedAt: null },
		overflow: null,
		retiredKeys: [],
		headObservations: [],
		sourceSnapshots: [],
		baselines: [],
		gates: [],
	};
}

export const sizeOf = (l: Ledger): number => Buffer.byteLength(JSON.stringify(l));
export const pushRing = <T>(ring: T[], item: T, cap: number): void => {
	ring.push(item);
	while (ring.length > cap) ring.shift();
};

export type Admission = "stored" | "existing" | "failed";

export function noteOverflow(L: Ledger, key: string, now: number): void {
	if (!L.overflow) L.overflow = { firstAt: now, lastAt: now, pendingKeys: [], keysTruncated: false };
	const ov = L.overflow;
	ov.lastAt = now;
	if (ov.pendingKeys.includes(key)) return;
	if (ov.pendingKeys.length >= 256) ov.keysTruncated = true;
	else ov.pendingKeys.push(key);
}

/** Open < 64, total <= 128 after eviction, projected size <= 512 KiB; otherwise the key is recorded as pending. */
export function admit(L: Ledger, g: OpenGate, now: number): Admission {
	if (L.gates.some(x => x.key === g.key) || L.retiredKeys.includes(g.key)) return "existing";
	let evict: ResolvedGate | undefined;
	if (L.gates.filter(isOpen).length >= 64) return fail(L, g, now);
	if (L.gates.length >= 128) {
		evict = L.gates.filter((x): x is ResolvedGate => !isOpen(x)).sort((a, b) => a.resolvedAt - b.resolvedAt)[0];
		if (!evict) return fail(L, g, now);
	}
	const retired = evict ? [...L.retiredKeys, evict.key].slice(-512) : L.retiredKeys;
	const trial: Ledger = { ...L, retiredKeys: retired, gates: [...L.gates.filter(x => x !== evict), g] };
	if (sizeOf(trial) > LEDGER_MAX) return fail(L, g, now);
	L.retiredKeys = trial.retiredKeys;
	L.gates = trial.gates;
	return "stored";
}
export function fail(L: Ledger, g: OpenGate, now: number): Admission {
	noteOverflow(L, g.key, now);
	return "failed";
}

// ---------------------------------------------------------------------------
// Facts: launches and observations (from hook events and the transcript)
// ---------------------------------------------------------------------------

export interface LaunchFact {
	key: string;
	toolCallD: string;
	toolCallAt: number;
	isolated: boolean;
	expected: number | null;
	complete: boolean;
	jobs: Array<[jobD: string, subD: string]>;
	origin: "hook" | "transcript";
	file?: string;
}
export interface ObsItem {
	jobD: string;
	subD: string | null;
	type: string | null;
	status: string;
}
export interface ObsFact {
	at: number;
	toolCallD: string | null;
	source: "subagent" | "job" | "async_result";
	origin: "hook" | "transcript";
	items: ObsItem[];
	file?: string;
}

export function launchFromEvent(e: Record<string, unknown>, file: string): LaunchFact | null {
	const jobs = e.jobs;
	if (typeof e.key !== "string" || !KEY.test(e.key) || !isHex16(e.toolCallD) || !isInt(e.toolCallAt)) return null;
	if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 64) return null;
	if (!jobs.every(j => Array.isArray(j) && isHex16(j[0]) && isHex16(j[1]))) return null;
	return {
		key: e.key,
		toolCallD: e.toolCallD,
		toolCallAt: e.toolCallAt,
		isolated: e.isolated === true,
		expected: isInt(e.expected) ? e.expected : null,
		complete: e.complete === true,
		jobs: (jobs as string[][]).map(j => [j[0] as string, j[1] as string]),
		origin: "hook",
		file,
	};
}

export function obsFromEvent(kind: "subagent" | "job", e: Record<string, unknown>, file: string): ObsFact | null {
	if (!isInt(e.at) || !Array.isArray(e.items) || e.items.length > 256) return null;
	const items: ObsItem[] = [];
	for (const it of e.items) {
		if (!Array.isArray(it) || !isHex16(it[0]) || typeof it[1] !== "string" || typeof it[2] !== "string") return null;
		items.push(
			kind === "subagent"
				? { jobD: it[0], subD: it[1], type: null, status: normalizeStatus(it[2]) }
				: { jobD: it[0], subD: null, type: it[1], status: normalizeStatus(it[2]) },
		);
	}
	return { at: e.at, toolCallD: isHex16(e.toolCallD) ? e.toolCallD : null, source: kind, origin: "hook", items, file };
}

export function terminalStatus(status: string, tracked: boolean): string | null {
	if (status === "not_found") return tracked ? "inferred" : null;
	return TERMINAL.has(status) ? status : null;
}

export interface Ctx {
	L: Ledger;
	now: number;
	/** Job digests belonging to launches that could not be admitted; their observations wait for absorption. */
	retainedJobs: Set<string>;
	absorbedAtStep9: Set<string>;
}

export function baselineFor(
	L: Ledger,
	toolCallD: string | null,
	at: number,
): Pick<OpenGate, "baselineHead" | "baselineSource" | "baselineAt"> {
	const hit = toolCallD ? L.baselines.find(b => b[0] === toolCallD && b[1] !== null) : undefined;
	if (hit) return { baselineHead: hit[1], baselineSource: "before_hook", baselineAt: hit[2] };
	const prior = L.headObservations.filter(h => h.at < at && h.head !== null).sort((a, b) => b.at - a.at)[0];
	if (prior) return { baselineHead: prior.head, baselineSource: "prior_observation", baselineAt: prior.at };
	return { baselineHead: null, baselineSource: "none", baselineAt: null };
}

export function makeGate(
	L: Ledger,
	p: Pick<
		OpenGate,
		"key" | "trigger" | "origin" | "openedAt" | "toolCallAt" | "isolated" | "expectedJobs" | "jobSetComplete" | "jobs"
	> &
		Partial<Pick<OpenGate, "subagentDigest" | "priorJobDigest">> & { toolCallD: string | null },
): OpenGate {
	const { toolCallD, ...rest } = p;
	return {
		...rest,
		id: gateIdOf(p.key),
		...baselineFor(L, toolCallD, p.toolCallAt || p.openedAt),
		subagentDigest: p.subagentDigest ?? null,
		priorJobDigest: p.priorJobDigest ?? null,
		quiescentAt: null,
		lastGapMask: 0,
		loopRuns: 0,
		subState: null,
		subStateAt: null,
	};
}

export function admitLaunch(c: Ctx, f: LaunchFact): Admission {
	const gate = makeGate(c.L, {
		key: f.key,
		trigger: "task_launch",
		origin: f.origin,
		openedAt: f.toolCallAt,
		toolCallAt: f.toolCallAt,
		isolated: f.isolated,
		expectedJobs: f.expected,
		jobSetComplete: f.complete,
		jobs: f.jobs.map(([jobD, subD]) => [jobD, subD, "running", 0, null, "subagent"] as JobTuple),
		toolCallD: f.toolCallD,
	});
	const res = admit(c.L, gate, c.now);
	if (res === "failed") for (const [jobD] of f.jobs) c.retainedJobs.add(jobD);
	return res;
}

export function applyObs(c: Ctx, obs: ObsFact): void {
	const open = c.L.gates.filter(isOpen);
	for (const item of obs.items) {
		let tracked = false;
		// `inResume`: an open resume gate already covers this subagent. F2: a queued resume ALWAYS opens its own resume
		// gate unless one is open for the same subagent, whatever state the prior job id has in other gates.
		let inResume = false;
		for (const g of open) {
			for (const t of g.jobs) {
				if (t[0] !== item.jobD) continue;
				tracked = true;
				if (t[3] === 1) continue;
				const term = terminalStatus(item.status, true);
				if (item.subD && t[1] !== item.subD) t[1] = item.subD;
				if (term) Object.assign(t, { 2: term, 3: 1, 4: obs.at, 5: obs.source });
				else t[2] = item.status;
			}
			if (obs.source === "async_result") continue;
			const isSub = obs.source === "subagent" && g.key.startsWith("resume:") && g.subagentDigest === item.subD;
			if (isSub) {
				tracked = true;
				inResume = true;
				g.subState = item.status;
				g.subStateAt = obs.at;
				if (item.jobD !== g.priorJobDigest && g.jobs.length < 64 && !g.jobs.some(t => t[0] === item.jobD)) {
					const term = terminalStatus(item.status, true);
					g.jobs.push([
						item.jobD,
						item.subD ?? "",
						term ?? item.status,
						term ? 1 : 0,
						term ? obs.at : null,
						"subagent",
					]);
				}
			} else if (g.key.startsWith("resume:") && g.jobs.length === 0 && item.jobD === g.priorJobDigest) {
				// A listing of the PRIOR job (any status, e.g. its own `cancelled`) is not an observation of the resumed
				// run: it covers the subagent against a duplicate gate but never sets `subState` (F2, B2).
				tracked = true;
				inResume = true;
			}
		}
		const queuedResume = obs.source === "subagent" && item.subD && item.status === "queued";
		if ((queuedResume ? inResume : tracked) || obs.source === "async_result" || c.retainedJobs.has(item.jobD))
			continue;
		if (terminalStatus(item.status, false) || item.status === "not_found") continue;
		const key = `job:${item.jobD}`;
		const origin = obs.origin;
		if (obs.source === "subagent" && item.subD) {
			if (item.status === "queued") {
				const toolCallD = obs.toolCallD ?? d16(`${item.subD}:${obs.at}`);
				const g = makeGate(c.L, {
					key: `resume:${item.subD}:${toolCallD}`,
					trigger: "subagent_resume",
					origin,
					openedAt: obs.at,
					toolCallAt: obs.at,
					isolated: false,
					expectedJobs: null,
					jobSetComplete: false,
					jobs: [],
					subagentDigest: item.subD,
					priorJobDigest: item.jobD,
					toolCallD: null,
				});
				g.subState = "queued";
				g.subStateAt = obs.at;
				if (admit(c.L, g, c.now) === "stored") open.push(g);
			} else if (item.status === "running") {
				const g = makeGate(c.L, {
					key,
					trigger: "subagent_resume",
					origin,
					openedAt: obs.at,
					toolCallAt: obs.at,
					isolated: false,
					expectedJobs: 1,
					jobSetComplete: true,
					jobs: [[item.jobD, item.subD, "running", 0, null, "subagent"]],
					subagentDigest: item.subD,
					toolCallD: null,
				});
				if (admit(c.L, g, c.now) === "stored") open.push(g);
			}
		} else if (obs.source === "job" && item.type === "task") {
			const g = makeGate(c.L, {
				key,
				trigger: "discovered",
				origin,
				openedAt: obs.at,
				toolCallAt: obs.at,
				isolated: false,
				expectedJobs: null,
				jobSetComplete: false,
				jobs: [[item.jobD, "", item.status, 0, null, "job"]],
				toolCallD: null,
			});
			if (admit(c.L, g, c.now) === "stored") open.push(g);
		}
	}
}

// ---------------------------------------------------------------------------
// Transcript walk (bounded; never getBranch)
// ---------------------------------------------------------------------------

export interface WalkManager {
	getSessionId(): string;
	getLeafId(): string | null;
	getEntry(id: string): unknown;
	getHeader?(): unknown;
}

export interface WalkResult {
	walked: number;
	complete: boolean;
	truncated: boolean;
	leaf: string | null;
	leafTimestamp: number;
	lowestId: string | null;
	entries: Record<string, unknown>[];
	pendingSkipped: boolean;
	/** An entry id on the chain could not be resolved: the scan is truncated, never complete. */
	unresolved: boolean;
}

export function walk(mgr: WalkManager, L: Ledger, cap: number, now: () => number): WalkResult {
	const started = now();
	const leaf = mgr.getLeafId();
	const res: WalkResult = {
		walked: 0,
		complete: false,
		truncated: false,
		leaf,
		leafTimestamp: 0,
		lowestId: null,
		entries: [],
		pendingSkipped: false,
		unresolved: false,
	};
	let id = leaf;
	for (;;) {
		if (id === null) {
			res.complete = true;
			break;
		}
		if (L.scan.cursor && id === L.scan.cursor.entryId) {
			res.complete = true;
			break;
		}
		if (L.scan.pending && id === L.scan.pending.topId) {
			const bottom = asRecord(mgr.getEntry(L.scan.pending.bottomId));
			if (!bottom || (bottom.parentId !== null && typeof bottom.parentId !== "string")) {
				// Invalid stored id: reset the scan and restart from the leaf.
				L.scan.pending = null;
				Object.assign(res, { walked: 0, leafTimestamp: 0, lowestId: null, entries: [], pendingSkipped: false });
				id = leaf;
				continue;
			}
			res.pendingSkipped = true;
			id = bottom.parentId;
			continue;
		}
		if (res.walked >= cap || now() - started >= WALK_MS) {
			res.truncated = true;
			break;
		}
		const e = asRecord(mgr.getEntry(id));
		res.walked++;
		if (!e) {
			res.unresolved = true;
			res.truncated = true;
			break;
		}
		const ts = Date.parse(String(e.timestamp));
		if (id === leaf) res.leafTimestamp = Number.isNaN(ts) ? 0 : ts;
		if (!Number.isNaN(ts) && ts < L.scan.floor) {
			res.complete = true;
			break;
		}
		res.entries.push(e);
		res.lowestId = id;
		id = typeof e.parentId === "string" ? e.parentId : null;
	}
	res.entries.reverse();
	return res;
}

export function transcriptFacts(entries: readonly Record<string, unknown>[]): {
	launches: LaunchFact[];
	obs: ObsFact[];
} {
	const launches: LaunchFact[] = [];
	const obs: ObsFact[] = [];
	const callAt = new Map<string, number>();
	for (const e of entries) {
		const at = Date.parse(String(e.timestamp));
		if (Number.isNaN(at)) continue;
		if (e.type === "custom_message" && e.customType === "async-result") {
			const jobs = asRecord(e.details)?.jobs;
			const items: ObsItem[] = [];
			for (const j of Array.isArray(jobs) ? jobs.slice(0, 64) : []) {
				const id = asString(asRecord(j)?.jobId);
				if (id) items.push({ jobD: d16(id), subD: null, type: null, status: "completed_or_failed" });
			}
			if (items.length > 0) obs.push({ at, toolCallD: null, source: "async_result", origin: "transcript", items });
			continue;
		}
		const m = asRecord(e.message);
		if (e.type !== "message" || !m) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content.slice(0, 64)) {
				const blk = asRecord(b);
				const id = blk?.type === "toolCall" ? asString(blk.id) : null;
				if (id && !callAt.has(id)) callAt.set(id, at);
			}
			continue;
		}
		if (m.role !== "toolResult" || m.isError === true) continue;
		const details = asRecord(m.details);
		const toolCallId = asString(m.toolCallId);
		if (m.toolName === "task") {
			const asyncInfo = asRecord(details?.async);
			const jobId = asString(asyncInfo?.jobId);
			if (asyncInfo?.state !== "running" || !jobId || !toolCallId) continue;
			const parsed = parseLaunchText(asRecord(Array.isArray(m.content) ? m.content[0] : null)?.text, jobId);
			launches.push({
				key: taskGateKey(toolCallId),
				toolCallD: d16(toolCallId),
				toolCallAt: callAt.get(toolCallId) ?? 0,
				isolated: false,
				expected: parsed.expected,
				complete: parsed.complete,
				jobs: parsed.jobs.map(j => [d16(j.jobId), d16(j.subagentId)]),
				origin: "transcript",
			});
		} else if (m.toolName === "subagent" && Array.isArray(details?.subagents)) {
			const items = subagentItems(details).map(([jobD, subD, status]) => ({ jobD, subD, type: null, status }));
			if (items.length > 0)
				obs.push({ at, toolCallD: toolCallDigest(toolCallId), source: "subagent", origin: "transcript", items });
		} else if (m.toolName === "job" && details) {
			const items = jobItems(details).items.map(([jobD, type, status]) => ({ jobD, subD: null, type, status }));
			if (items.length > 0) obs.push({ at, toolCallD: null, source: "job", origin: "transcript", items });
		}
	}
	return { launches, obs };
}

interface HookApi {
	on(event: string, handler: (...args: never[]) => unknown): void;
	logger?: HookLogger;
}

/** Registers exactly one `tool_call` handler (the host filters by the declared `task` target). */
export default function registerVerificationBaseline(api: HookApi): void {
	api.on("tool_call", createBaselineHandler(hookDepsFromLayout(import.meta.dir, BASELINE_BUDGET_MS, api.logger)));
}
