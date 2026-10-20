/**
 * verification-receipts: `verification_loop` - rechecks the current session's delegation gates.
 * Merges hook events, walks the transcript (bounded), evaluates gates and persists a private ledger.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin `verification-receipts`
 * (MIT, Copyright (c) 2026 jjongguet). See NOTICE.md and LICENSE.gjc-plugin.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CustomToolAPI } from "@sayknow-cli/coding-agent";
import {
	admitLaunch,
	applyObs,
	type Ctx,
	FLOOR_SLACK_MS,
	GAP_KINDS,
	type GapKind,
	HEX_SHA,
	isHead,
	isHex16,
	isInt,
	isOpen,
	type LaunchFact,
	LEDGER_MAX,
	type Ledger,
	launchFromEvent,
	newLedger,
	type ObsFact,
	type OpenGate,
	obsFromEvent,
	pushRing,
	type ResolvedGate,
	StoreBusyError,
	type StoredGate,
	transcriptFacts,
	validateLedger,
	type WalkManager,
	type WalkResult,
	walk,
	withLock,
} from "../hooks/verification-baseline";
import {
	asRecord,
	EVENT_FILE,
	ensureChain,
	eventsParts,
	fsyncDir,
	MARKER_FILE,
	MAX_EVENT_BYTES,
	MAX_EVENT_FILES,
	type Receipt,
	readCapped,
	sha256Hex,
	writeNew,
} from "../hooks/verification-gate";
import {
	type ChangedSet,
	evaluateGates,
	type GateEval,
	isSelectableTestPath,
	type ReceiptFact,
	terminalAtOf,
} from "./verification-run";
import {
	DEFAULT_LIMITS,
	type FingerprintLimits,
	fingerprint,
	type GitContext,
	jsonResult,
	loadRepoReceipts,
	makeGitContext,
	openToolStore,
	pidAlive,
	resolveRepo,
	runGit,
} from "./verification-status";

export const WALK_CAP = 20000;
const LOOP_BUDGET_MS = 15_000;
const GAP_ORDER: readonly GapKind[] = GAP_KINDS;
const ACTIONS: Record<GapKind, string> = {
	delegation_terminal_unobserved:
		"observe the delegated work finishing: `subagent` await/list, then `job` with list: true",
	delegation_job_set_partial: "call `job` with list: true after all delegated work finished so quiescence is observed",
	no_receipt_after_terminal: "run verification_run on explicit test files covering the delegated change",
	receipt_not_passed: "fix the failing tests, then rerun verification_run",
	receipt_no_tests: "select test files that execute at least one test, then rerun verification_run",
	receipt_incomplete: "rerun verification_run; the previous run did not complete",
	receipt_changed_during_run: "rerun verification_run while the tree is quiet",
	receipt_freshness_unavailable: "rerun verification_run; freshness could not be established",
	receipt_stale: "sources changed after the receipt; rerun verification_run",
	changed_test_uncovered: "cover the listed changed test files with a passing verification_run",
	changed_set_unavailable: "rerun verification_run on the changed tests; the changed set could not be computed",
	gate_state_dropped: "gate state may be incomplete; observe delegated work again and rerun verification_loop",
	scan_truncated: "rerun verification_loop to finish scanning the transcript",
	budget_exhausted: "rerun verification_loop; the time budget ended before every gate was checked",
};

// ---------------------------------------------------------------------------
// Changed test files since a baseline
// ---------------------------------------------------------------------------

const GIT_CAP = 8 * 1024 * 1024;
const EXCLUDED = new Set([".git", ".skc", "node_modules"]);

async function gitPaths(g: GitContext, args: string[]): Promise<string[] | null> {
	const r = await runGit(g, args, { kind: "capture", cap: GIT_CAP });
	if (!r.ok || r.exitCode !== 0) return null;
	return r.stdout
		.toString("utf8")
		.split("\0")
		.map(p => p.replace(/^\n+|\n+$/g, ""))
		.filter(p => p.length > 0);
}

async function changedTests(g: GitContext, gate: OpenGate, warnings: Set<string>): Promise<ChangedSet> {
	const all = new Set<string>();
	const add = (list: string[] | null): boolean => {
		if (!list) return false;
		for (const p of list) all.add(p);
		return true;
	};
	let head = gate.baselineSource === "none" ? null : gate.baselineHead;
	if (head) {
		const probe = HEX_SHA.test(head)
			? await runGit(g, ["cat-file", "-e", `${head}^{commit}`], { kind: "capture", cap: 4096 })
			: null;
		if (!probe?.ok || probe.exitCode !== 0) {
			warnings.add("baseline_unreachable");
			head = null;
		}
	}
	let ok: boolean;
	if (head) {
		ok = add(await gitPaths(g, ["diff-index", "--name-only", "-z", "--no-renames", "--diff-filter=d", head]));
	} else {
		if (gate.baselineSource === "none") warnings.add("baseline_fallback_since");
		const since = `--since=@${Math.max(0, Math.floor(((gate.toolCallAt || gate.openedAt) - FLOOR_SLACK_MS) / 1000))}`;
		const count = await runGit(g, ["rev-list", since, "-n", "201", "HEAD"], { kind: "capture", cap: 64 * 1024 });
		const commits =
			count.ok && count.exitCode === 0 ? count.stdout.toString("utf8").split("\n").filter(Boolean).length : 201;
		ok =
			commits <= 200 &&
			add(await gitPaths(g, ["log", since, "-n", "200", "--name-only", "--diff-filter=d", "--format=", "-z"])) &&
			add(await gitPaths(g, ["diff-index", "--name-only", "-z", "--no-renames", "--diff-filter=d", "HEAD"]));
	}
	ok = ok && add(await gitPaths(g, ["ls-files", "--others", "--exclude-standard", "-z"]));
	if (!ok) return { ok: false, files: [] };
	const files = [...all]
		.filter(p => isSelectableTestPath(p, "bun-test") && !p.split("/").some(s => EXCLUDED.has(s)))
		.sort();
	return { ok: true, files };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type LoopStatus = "clean" | "gaps" | "blocked";
export interface LoopDetails {
	status: LoopStatus;
	reason: string | null;
	scope: "current_session";
	gates: Array<{
		id8: string;
		trigger: string;
		origin: string;
		openedAt: number;
		jobs: { total: number; terminal: number };
		jobSetComplete: boolean;
		baselineSource: string;
		resolution: string | null;
		gapKinds: GapKind[];
	}>;
	gapKinds: GapKind[];
	openGates: number;
	resolvedGates: number;
	newlyResolved: number;
	transcript: { walkedEntries: number; truncated: boolean; pendingSegment: boolean; reconstructedGates: number };
	overflow: { pendingKeys: number; keysTruncated: boolean } | null;
	uncoveredTests: string[];
	requiredActions: string[];
	warnings: string[];
	notes: string[];
	advisoryOnly: true;
}

export interface LoopDeps {
	walkCap?: number;
	now?: () => number;
	budgetMs?: number;
	env?: NodeJS.ProcessEnv;
	limits?: FingerprintLimits;
	gitTimeoutMs?: number;
}
interface LoopCtx {
	sessionManager: WalkManager;
}

function blocked(reason: string, sub?: string): LoopDetails {
	return {
		status: "blocked",
		reason: sub ? `${reason}:${sub}` : reason,
		scope: "current_session",
		gates: [],
		gapKinds: [],
		openGates: 0,
		resolvedGates: 0,
		newlyResolved: 0,
		transcript: { walkedEntries: 0, truncated: false, pendingSegment: false, reconstructedGates: 0 },
		overflow: null,
		uncoveredTests: [],
		requiredActions: [],
		warnings: [],
		notes: [],
		advisoryOnly: true,
	};
}

const maskOf = (kinds: readonly GapKind[]): number => kinds.reduce((m, k) => m | (1 << GAP_ORDER.indexOf(k)), 0);

async function readJson(dir: string, name: string): Promise<Record<string, unknown> | null> {
	try {
		return asRecord(JSON.parse((await readCapped(fs, path.join(dir, name), MAX_EVENT_BYTES, true)).toString("utf8")));
	} catch {
		return null;
	}
}

async function persist(dir: string, name: string, L: Ledger): Promise<void> {
	const body = JSON.stringify(L);
	if (Buffer.byteLength(body) > LEDGER_MAX) throw new Error("ledger too large");
	const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
	await writeNew(fs, tmp, body);
	try {
		await fs.rename(tmp, path.join(dir, name));
	} catch (error) {
		await fs.unlink(tmp).catch(() => undefined);
		throw error;
	}
	await fsyncDir(fs, dir);
}

async function writeJournal(storeRoot: string, at: number, d: LoopDetails): Promise<boolean> {
	try {
		const dir = await ensureChain(fs, storeRoot, ["journal", "v1"], true);
		if (!dir) return false;
		const day = new Date(at).toISOString().slice(0, 10);
		const line = `${JSON.stringify({ at, status: d.status, reason: d.reason, gaps: d.gapKinds, open: d.openGates, resolved: d.resolvedGates }).slice(0, 2040)}\n`;
		const file = path.join(dir, `${day}.jsonl`);
		const size = await fs.lstat(file).then(
			s => s.size,
			() => 0,
		);
		if (size + line.length <= 1024 * 1024) {
			const h = await fs.open(
				file,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await h.writeFile(line);
			} finally {
				await h.close();
			}
		}
		const cutoff = new Date(at - 14 * 86_400_000).toISOString().slice(0, 10);
		for (const n of await fs.readdir(dir))
			if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) < cutoff)
				await fs.unlink(path.join(dir, n)).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export async function executeLoop(
	pi: CustomToolAPI,
	ctx: LoopCtx,
	deps: LoopDeps = {},
	toolDir: string = import.meta.dir,
): Promise<LoopDetails> {
	const now = deps.now ?? Date.now;
	const started = now();
	const deadline = started + (deps.budgetMs ?? LOOP_BUDGET_MS);
	if (process.platform === "win32") return blocked("platform_unsupported");
	const store = await openToolStore(pi, toolDir);
	if (!store.ok) return blocked("store_unavailable", store.reason);
	const repo = await resolveRepo(await makeGitContext(pi.cwd, deps.gitTimeoutMs, deps.env), pi.cwd);
	if (!repo.ok) return blocked(repo.reason);
	const sessionDigest = sha256Hex(ctx.sessionManager.getSessionId());
	const ledgerDir = await ensureChain(fs, store.storeRoot, ["ledger", "v1", repo.repoDigest], true).catch(() => null);
	if (!ledgerDir) return blocked("store_unavailable", "unsafe_permissions");
	const ledgerName = `${sessionDigest}.json`;
	let details: LoopDetails;
	try {
		details = await withLock(fs, path.join(ledgerDir, `${sessionDigest}.lock`), { pidAlive, waitMs: 1000, now }, () =>
			runLocked(
				ctx,
				deps,
				store.storeRoot,
				repo.toplevel,
				repo.repoDigest,
				sessionDigest,
				ledgerDir,
				ledgerName,
				repo.git,
				now,
				deadline,
			),
		);
	} catch (error) {
		if (error instanceof StoreBusyError) return blocked("store_busy");
		pi.logger.warn("verification_loop failed", { error: String(error) });
		return blocked("state_unavailable");
	}
	if (!(await writeJournal(store.storeRoot, now(), details))) details.warnings.push("journal_not_persisted");
	return details;
}

async function runLocked(
	ctx: LoopCtx,
	deps: LoopDeps,
	storeRoot: string,
	toplevel: string,
	repoDigest: string,
	sessionDigest: string,
	ledgerDir: string,
	ledgerName: string,
	g: GitContext,
	now: () => number,
	deadline: number,
): Promise<LoopDetails> {
	const warnings = new Set<string>();
	const notes = new Set<string>();
	// 4. ledger
	let L: Ledger;
	try {
		const raw = await readCapped(fs, path.join(ledgerDir, ledgerName), LEDGER_MAX, true).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		});
		const parsed = raw
			? validateLedger(JSON.parse(raw.toString("utf8")), repoDigest, sessionDigest)
			: newLedger(repoDigest, sessionDigest, now());
		if (!parsed) return blocked("state_unavailable");
		L = parsed;
	} catch {
		return blocked("state_unavailable");
	}
	const c: Ctx = { L, now: now(), retainedJobs: new Set(), absorbedAtStep9: new Set() };
	if (asRecord(ctx.sessionManager.getHeader?.())?.parentSession) warnings.add("predecessor_session_not_scanned");

	// 5. merge events and markers
	const eventsDir = await ensureChain(fs, storeRoot, eventsParts(repoDigest, sessionDigest), false).catch(
		() => "unsafe" as const,
	);
	if (eventsDir === "unsafe") return blocked("state_unavailable");
	const launches: LaunchFact[] = [];
	const obsEvents: ObsFact[] = [];
	const deletable = new Set<string>();
	const markers: Array<{ name: string; epoch: number }> = [];
	const lowerFloor = (epoch: number): void => {
		if (epoch - FLOOR_SLACK_MS < L.scan.floor) {
			L.scan.floor = epoch - FLOOR_SLACK_MS;
			L.scan.cursor = null;
			L.scan.pending = null;
		}
	};
	const quiescence: Array<{ at: number; name: string }> = [];
	let eventsTruncated = false;
	if (eventsDir) {
		// Markers sort first: a full directory (hooks write OVERFLOW exactly then) must never hide them.
		const isMarker = (n: string): number => (MARKER_FILE.test(n) ? 0 : 1);
		const names = (await fs.readdir(eventsDir)).sort(
			(a, b) => isMarker(a) - isMarker(b) || (a < b ? -1 : a > b ? 1 : 0),
		);
		eventsTruncated = names.length > MAX_EVENT_FILES;
		for (const name of names.slice(0, MAX_EVENT_FILES)) {
			const marker = name.match(MARKER_FILE);
			if (marker?.[2]) {
				markers.push({ name, epoch: Number(marker[2]) });
				lowerFloor(Number(marker[2]));
				continue;
			}
			const m = name.match(EVENT_FILE);
			if (!m?.[2]) continue;
			const e = await readJson(eventsDir, name);
			const kind = m[2];
			const at = Number(m[1]);
			let handled = false;
			if (e && e.v === 1 && e.kind === kind) {
				if (kind === "baseline" && isHex16(e.toolCallD) && isHead(e.head) && isInt(e.baselineAt)) {
					if (!L.baselines.some(b => b[0] === e.toolCallD))
						pushRing(L.baselines, [e.toolCallD, e.head, e.baselineAt], 64);
					if (e.head) pushRing(L.headObservations, { at: e.baselineAt, head: e.head, source: "hook_fs" }, 32);
					handled = true;
				} else if (kind === "launch") {
					const f = launchFromEvent(e, name);
					if (f) launches.push(f);
					handled = f !== null;
				} else if (kind === "subagent" || kind === "job") {
					const f = obsFromEvent(kind, e, name);
					if (f) obsEvents.push(f);
					handled = f !== null;
				} else if (kind === "quiescence" && isInt(e.at)) {
					quiescence.push({ at: e.at, name });
					handled = true;
				} else if (kind === "snapshot" && isInt(e.at) && typeof e.sourceDigest === "string" && isHead(e.head)) {
					L.sourceSnapshots.push({
						at: e.at,
						sourceDigest: e.sourceDigest,
						head: e.head,
						by: e.by === "status" ? "status" : "run",
					});
					L.sourceSnapshots.sort((a, b) => a.at - b.at);
					while (L.sourceSnapshots.length > 32) L.sourceSnapshots.shift();
					handled = true;
				}
			}
			if (!handled) lowerFloor(at);
			deletable.add(name);
		}
	}
	const retainedLaunchFiles = new Map<string, LaunchFact>();
	for (const f of launches) {
		if (admitLaunch(c, f) === "failed" && f.file) retainedLaunchFiles.set(f.file, f);
	}
	// Quiescence is applied only after every admission path (hook, transcript, step 9) so same-batch launches count.
	const applyQuiescence = (): void => {
		for (const q of quiescence)
			for (const gate of L.gates.filter(isOpen))
				if (gate.openedAt <= q.at) gate.quiescentAt = Math.max(gate.quiescentAt ?? 0, q.at);
	};
	const hookObs = obsEvents.sort((a, b) => a.at - b.at);

	// 6. bounded walk
	let walkRes: WalkResult;
	try {
		walkRes = walk(ctx.sessionManager, L, deps.walkCap ?? WALK_CAP, now);
	} catch {
		return blocked("state_unavailable");
	}
	const tf = transcriptFacts(walkRes.entries);
	let reconstructed = 0;
	const failedTranscript: LaunchFact[] = [];
	for (const f of tf.launches) {
		const res = admitLaunch(c, f);
		if (res === "stored") reconstructed++;
		else if (res === "failed") failedTranscript.push(f);
	}
	const allObs = [...hookObs, ...tf.obs].sort((a, b) => a.at - b.at);
	for (const o of allObs) applyObs(c, o);
	applyQuiescence();
	if (walkRes.unresolved) warnings.add("transcript_entry_unresolved");
	const unabsorbed = failedTranscript.length > 0;
	if (walkRes.complete && !unabsorbed) {
		L.scan.cursor = walkRes.leaf ? { entryId: walkRes.leaf, entryTimestamp: walkRes.leafTimestamp } : L.scan.cursor;
		L.scan.pending = null;
		L.scan.truncatedAt = null;
	} else if (walkRes.truncated && !unabsorbed) {
		if (walkRes.leaf && walkRes.lowestId) L.scan.pending = { topId: walkRes.leaf, bottomId: walkRes.lowestId };
		L.scan.truncatedAt ??= now();
	} else if (unabsorbed) {
		L.scan.pending = null;
		L.scan.truncatedAt = walkRes.complete ? null : (L.scan.truncatedAt ?? now());
	}

	// 7. facts
	const budgetLeft = (): boolean => now() < deadline;
	const limits = deps.limits ?? DEFAULT_LIMITS;
	const current = await fingerprint(g, toplevel, [], "verification-loop", limits);
	const sourceDigest = current.status === "available" ? current.sourceDigest : null;
	const receipts = (
		await loadRepoReceipts(fs, storeRoot, repoDigest).catch(() => {
			warnings.add("receipts_unreadable");
			return [];
		})
	).filter(r => r.sessionDigest === sessionDigest);
	let budgetCut = false;
	const openNow = L.gates.filter(isOpen);
	const minTerminal = Math.min(...openNow.map(terminalAtOf).filter((t): t is number => t !== null));
	const facts: ReceiptFact[] = [];
	const freshCache = new Map<string, ReceiptFact["freshNow"]>();
	for (const r of Number.isFinite(minTerminal) ? receipts.filter(x => x.startedAt >= minTerminal).slice(0, 8) : []) {
		if (!budgetLeft()) {
			budgetCut = true;
			break;
		}
		const ck = `${r.specDigest}:${r.selectedInputs.join("\0")}`;
		let freshNow = freshCache.get(ck);
		if (!freshNow) {
			const fp = await fingerprint(g, toplevel, r.selectedInputs, r.specDigest, limits);
			freshNow = fp.status !== "available" ? "unavailable" : fp.digest === r.after.digest ? "fresh" : "stale";
			freshCache.set(ck, freshNow);
		}
		facts.push({ receipt: r as Receipt, freshNow });
	}
	const changed = new Map<string, ChangedSet>();
	const changedCache = new Map<string, ChangedSet>();
	const skipped = new Set<string>();
	for (const gate of openNow) {
		if (terminalAtOf(gate) === null) continue;
		if (!budgetLeft()) {
			skipped.add(gate.id);
			continue;
		}
		const ck = `${gate.baselineSource}:${gate.baselineHead}:${gate.baselineSource === "none" ? gate.toolCallAt || gate.openedAt : 0}`;
		let cs = changedCache.get(ck);
		if (!cs) {
			cs = await changedTests(g, gate, warnings);
			changedCache.set(ck, cs);
		}
		changed.set(gate.id, cs);
	}

	// 8. evaluate
	const evals = evaluateGates({
		gates: openNow,
		sourceDigest,
		snapshots: L.sourceSnapshots,
		receipts: facts,
		changed,
		skipped,
	});
	const byId = new Map(evals.map(e => [e.id, e]));
	const uncovered = new Set<string>();
	let newlyResolved = 0;
	const resolvedNow = now();
	for (const gate of openNow) {
		const ev = byId.get(gate.id);
		if (!ev) continue;
		gate.loopRuns++;
		gate.lastGapMask = maskOf(ev.gapKinds);
		for (const u of ev.uncovered) uncovered.add(u);
		if (!ev.resolution) continue;
		const { jobs, subState, subStateAt, ...base } = gate;
		void subState;
		void subStateAt;
		const resolved: ResolvedGate = {
			...base,
			jobCount: jobs.length,
			resolvedAt: resolvedNow,
			resolution: ev.resolution,
			resolvedReceiptIds: ev.resolvedReceiptIds,
		};
		L.gates[L.gates.indexOf(gate)] = resolved;
		newlyResolved++;
	}

	// 9. R-clear
	const step9: OpenGate[] = [];
	const before = new Set(L.gates.map(x => x.key));
	const retryLaunches = [...retainedLaunchFiles.values(), ...failedTranscript];
	const stillRetained = new Map<string, LaunchFact>();
	c.retainedJobs.clear();
	for (const f of retryLaunches) {
		if (admitLaunch(c, f) === "failed") {
			if (f.file) stillRetained.set(f.file, f);
		}
	}
	for (const x of L.gates) if (isOpen(x) && !before.has(x.key)) step9.push(x);
	if (step9.length > 0) {
		for (const o of allObs) applyObs(c, o);
		applyQuiescence();
	}
	const keys = new Set([...L.gates.map(x => x.key), ...L.retiredKeys]);
	if (L.overflow) {
		L.overflow.pendingKeys = L.overflow.pendingKeys.filter(k => !keys.has(k));
		const clearable =
			!L.overflow.keysTruncated &&
			L.overflow.pendingKeys.every(k => keys.has(k)) &&
			stillRetained.size === 0 &&
			failedTranscript.every(f => keys.has(f.key)) &&
			L.overflow.pendingKeys.length === 0;
		if (clearable) {
			L.overflow = null;
			notes.add("overflow_cleared");
		}
	}
	const keepFiles = new Set(stillRetained.keys());
	for (const o of hookObs) if (o.file && o.items.some(i => c.retainedJobs.has(i.jobD))) keepFiles.add(o.file);
	// A quiescence observation whose launch could not be admitted yet is retained until the gate exists.
	if (stillRetained.size > 0 || failedTranscript.length > 0) for (const q of quiescence) keepFiles.add(q.name);

	// 10. markers
	const dropped =
		markers.length > 0 && !(L.scan.truncatedAt === null && L.scan.pending === null && L.overflow === null);
	const staleMarkers = markers.filter(m => L.scan.floor <= m.epoch - FLOOR_SLACK_MS && !dropped).map(m => m.name);

	// 11. persist
	const stamp = now();
	if (sourceDigest) {
		pushRing(L.sourceSnapshots, { at: stamp, sourceDigest, head: current.head, by: "loop" }, 32);
		pushRing(L.headObservations, { at: stamp, head: current.head, source: "tool_git" }, 32);
	}
	L.updatedAt = stamp;
	try {
		await persist(ledgerDir, ledgerName, L);
	} catch {
		return blocked("state_unavailable");
	}
	for (const name of [...deletable].filter(n => !keepFiles.has(n)))
		if (eventsDir) await fs.unlink(path.join(eventsDir, name)).catch(() => undefined);
	for (const name of staleMarkers) if (eventsDir) await fs.unlink(path.join(eventsDir, name)).catch(() => undefined);

	// Output
	const evalFor = (gate: StoredGate): GateEval | undefined => byId.get(gate.id);
	const step9Ids = new Set(step9.map(x => x.id));
	const gapAll = new Set<GapKind>();
	const gateOut: LoopDetails["gates"] = [];
	for (const gate of L.gates) {
		const ev = evalFor(gate);
		const isStep9 = step9Ids.has(gate.id);
		if (!ev && !isStep9) continue;
		const gaps: GapKind[] = isStep9
			? ["delegation_terminal_unobserved", "delegation_job_set_partial"]
			: (ev?.gapKinds ?? []);
		for (const k of gaps) gapAll.add(k);
		if (gateOut.length < 32) {
			const jobs = isOpen(gate) ? gate.jobs : [];
			gateOut.push({
				id8: gate.id.slice(0, 8),
				trigger: gate.trigger,
				origin: gate.origin,
				openedAt: gate.openedAt,
				jobs: isOpen(gate)
					? { total: jobs.length, terminal: jobs.filter(j => j[3] === 1).length }
					: { total: gate.jobCount, terminal: gate.jobCount },
				jobSetComplete: gate.jobSetComplete,
				baselineSource: gate.baselineSource,
				resolution: isOpen(gate) ? null : gate.resolution,
				gapKinds: gaps,
			});
		}
	}
	if (L.overflow || dropped || stillRetained.size > 0 || (markers.length > 0 && staleMarkers.length < markers.length))
		gapAll.add("gate_state_dropped");
	if (L.scan.truncatedAt !== null || eventsTruncated) gapAll.add("scan_truncated");
	if (budgetCut) gapAll.add("budget_exhausted");
	const kinds = GAP_ORDER.filter(k => gapAll.has(k));
	const openGates = L.gates.filter(isOpen).length;
	if (L.gates.length === 0) notes.add("no_gates_recorded");
	const details: LoopDetails = {
		...blocked("x"),
		status: kinds.length > 0 || openGates > 0 ? "gaps" : "clean",
		reason: null,
		gates: gateOut,
		gapKinds: kinds,
		openGates,
		resolvedGates: L.gates.length - openGates,
		newlyResolved,
		transcript: {
			walkedEntries: walkRes.walked,
			truncated: L.scan.truncatedAt !== null,
			pendingSegment: L.scan.pending !== null,
			reconstructedGates: reconstructed,
		},
		overflow: L.overflow
			? { pendingKeys: L.overflow.pendingKeys.length, keysTruncated: L.overflow.keysTruncated }
			: null,
		uncoveredTests: [...uncovered].sort().slice(0, 20),
		requiredActions: kinds.map(k => ACTIONS[k]).slice(0, 10),
		warnings: [...warnings],
		notes: [...notes],
	};
	return details;
}

export default function verificationLoopTool(pi: CustomToolAPI) {
	const z = pi.zod;
	return {
		name: "verification_loop",
		label: "Verification Loop",
		description:
			"Recheck this session's delegation verification gates (offline, <=15 s): merges recorded events, walks the transcript, and reports closed gap kinds with required actions. No parameters. Advisory only.",
		strict: true,
		concurrency: "exclusive" as const,
		parameters: z.strictObject({}),
		async execute(_toolCallId: string, _params: Record<string, never>, _onUpdate: unknown, ctx: LoopCtx) {
			try {
				return jsonResult(await executeLoop(pi, ctx));
			} catch (error) {
				pi.logger.warn("verification_loop failed", { error: String(error) });
				return jsonResult(blocked("state_unavailable"));
			}
		},
	};
}
