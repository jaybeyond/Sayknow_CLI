/**
 * verification-receipts: test runners (bun test / node --test), JUnit attribution, gate evaluation and the
 * `verification_run` tool.
 *
 * Independent re-implementation of the contracts of jjongguet/gjc-plugin
 * `verification-receipts` (MIT, Copyright (c) 2026 jjongguet). See NOTICE.md and LICENSE.gjc-plugin.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolAPI } from "@sayknow-cli/coding-agent";
import { type GapKind, type OpenGate, TERMINAL } from "../hooks/verification-baseline";
import {
	canonicalJson,
	type ExecCounts,
	type Execution,
	type Freshness,
	PLUGIN_NAME,
	PLUGIN_VERSION,
	type Receipt,
	readCapped,
	type SourceFingerprint,
	sha256Hex,
} from "../hooks/verification-gate";
import {
	boundedSpawn,
	buildEnv,
	DEFAULT_LIMITS,
	type FingerprintLimits,
	fingerprint,
	jsonResult,
	makeGitContext,
	openToolStore,
	resolveExecutable,
	resolveRepo,
	runFreshness,
	type SpawnResult,
	type StorageStatus,
	storeReceipt,
	writeSnapshotEvent,
} from "./verification-status";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Runner = "bun-test" | "node-test";
export type ValidationCode =
	| "invalid_file_count"
	| "invalid_test_path"
	| "not_a_test_file"
	| "excluded_path"
	| "path_escape"
	| "symlink_test_path"
	| "invalid_test_file"
	| "missing_test_file"
	| "duplicate_test_file";

const BUN_TEST_FILE = /^.+[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/;
const NODE_TEST_FILE = /^.+[._](?:test|spec)\.(?:js|mjs|cjs)$/;
const EXCLUDED_SEGMENTS = new Set([".git", ".skc", "node_modules"]);

export function isSelectableTestPath(rel: string, runner: Runner = "bun-test"): boolean {
	return (runner === "bun-test" ? BUN_TEST_FILE : NODE_TEST_FILE).test(path.posix.basename(rel));
}

/** Pure path-shape checks; the filesystem checks follow once the toplevel is known. */
export function validateFileList(files: unknown, runner: Runner): ValidationCode | null {
	if (!Array.isArray(files) || files.length < 1 || files.length > 32) return "invalid_file_count";
	const seen = new Set<string>();
	for (const file of files) {
		if (typeof file !== "string" || file.length === 0 || file.length > 4096) return "invalid_test_path";
		const segments = file.split("/");
		if (/[\u0000-\u001f\u007f\\*?[\]{}]/.test(file) || path.isAbsolute(file) || segments.length > 64)
			return "invalid_test_path";
		if (segments.some(s => s === "" || s === "." || s === ".." || s.startsWith("-"))) return "invalid_test_path";
		if (!isSelectableTestPath(file, runner)) return "not_a_test_file";
		if (segments.some(s => EXCLUDED_SEGMENTS.has(s))) return "excluded_path";
		if (seen.has(file)) return "duplicate_test_file";
		seen.add(file);
	}
	return null;
}

async function validateOnDisk(toplevel: string, files: readonly string[]): Promise<ValidationCode | null> {
	for (const file of files) {
		const abs = path.join(toplevel, file);
		let current = toplevel;
		const parts = file.split("/");
		for (const [i, part] of parts.entries()) {
			current = path.join(current, part);
			const st = await fs.lstat(current).catch(() => null);
			if (!st) return "missing_test_file";
			if (st.isSymbolicLink()) return "symlink_test_path";
			if (i < parts.length - 1 && !st.isDirectory()) return "invalid_test_file";
		}
		const real = await fs.realpath(abs).catch(() => null);
		if (!real || path.relative(toplevel, real).startsWith("..")) return "path_escape";
		if (!(await fs.lstat(abs)).isFile()) return "invalid_test_file";
	}
	return null;
}

// ---------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------

interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
		if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
		return ENTITIES[body] ?? whole;
	});
}

/** Strict, minimal XML element parser. Returns null for anything that is not well-formed with a single root. */
export function parseXml(text: string): XmlNode | null {
	const stack: XmlNode[] = [];
	let root: XmlNode | null = null;
	let i = 0;
	const attrRe = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
	const skip = (open: string, close: string): boolean => {
		const end = text.indexOf(close, i + open.length);
		if (end === -1) return false;
		i = end + close.length;
		return true;
	};
	try {
		while (i < text.length) {
			const lt = text.indexOf("<", i);
			if (lt === -1) {
				if (text.slice(i).trim() !== "") return null;
				break;
			}
			if (text.slice(i, lt).trim() !== "" && stack.length === 0) return null;
			i = lt;
			if (text.startsWith("<!--", i)) {
				if (!skip("<!--", "-->")) return null;
			} else if (text.startsWith("<![CDATA[", i)) {
				if (stack.length === 0 || !skip("<![CDATA[", "]]>")) return null;
			} else if (text.startsWith("<?", i)) {
				if (!skip("<?", "?>")) return null;
			} else if (text.startsWith("<!", i)) {
				if (!skip("<!", ">")) return null;
			} else if (text.startsWith("</", i)) {
				const m = /^<\/([A-Za-z_][\w:.-]*)\s*>/.exec(text.slice(i, i + 300));
				const top = stack.pop();
				if (!m || !top || top.name !== m[1]) return null;
				i += m[0].length;
			} else {
				const m = /^<([A-Za-z_][\w:.-]*)/.exec(text.slice(i, i + 300));
				if (!m?.[1]) return null;
				const node: XmlNode = { name: m[1], attrs: {}, children: [] };
				i += m[0].length;
				for (;;) {
					attrRe.lastIndex = i;
					const a = attrRe.exec(text);
					if (!a) break;
					if (a[1] === undefined || a[1] in node.attrs) return null;
					node.attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? "");
					i = attrRe.lastIndex;
				}
				const close = /^\s*(\/?)>/.exec(text.slice(i, i + 40));
				if (!close) return null;
				i += close[0].length;
				const parent = stack[stack.length - 1];
				if (parent) parent.children.push(node);
				else if (root) return null;
				else root = node;
				if (close[1] !== "/") stack.push(node);
			}
			if (stack.length === 0 && root && text.slice(i).trim() === "") break;
		}
	} catch {
		return null;
	}
	return stack.length === 0 ? root : null;
}

export type ParsedReport = { counts: ExecCounts; perInput: ExecCounts[] } | null;

const emptyCounts = (): ExecCounts => ({ tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 });
const intAttr = (v: string | undefined): number | null =>
	v !== undefined && /^[0-9]{1,6}$/.test(v) && Number(v) <= 100_000 ? Number(v) : null;

function finishCounts(c: ExecCounts): boolean {
	c.passed = c.tests - c.failed - c.errors - c.skipped;
	return c.passed >= 0;
}

function sumCounts(list: readonly ExecCounts[]): ExecCounts {
	const total = emptyCounts();
	for (const c of list) {
		total.tests += c.tests;
		total.passed += c.passed;
		total.failed += c.failed;
		total.errors += c.errors;
		total.skipped += c.skipped;
	}
	return total;
}

/** Map a runner-reported file path to its selected-input index (toplevel-relative POSIX), or -1. */
function attribute(file: string, toplevelReal: string, inputs: readonly string[]): number {
	const rel = path.isAbsolute(file)
		? path.relative(toplevelReal, file)
		: path.posix.normalize(file.replace(/^\.\//, ""));
	return inputs.indexOf(rel.split(path.sep).join("/"));
}

/** bun JUnit: one `<testsuites>` root with integer totals; each direct child `<testsuite>` is one file. */
export function parseBunReport(xml: string, toplevelReal: string, inputs: readonly string[]): ParsedReport {
	const root = parseXml(xml);
	if (root?.name !== "testsuites") return null;
	const tests = intAttr(root.attrs.tests);
	const failures = intAttr(root.attrs.failures);
	const skipped = intAttr(root.attrs.skipped);
	const errors = root.attrs.errors === undefined ? 0 : intAttr(root.attrs.errors);
	if (tests === null || failures === null || skipped === null || errors === null) return null;
	const perInput = inputs.map(emptyCounts);
	const seen = new Set<number>();
	for (const suite of root.children.filter(c => c.name === "testsuite")) {
		const index = attribute(suite.attrs.file ?? suite.attrs.name ?? "", toplevelReal, inputs);
		const c = perInput[index];
		const t = intAttr(suite.attrs.tests);
		const f = intAttr(suite.attrs.failures);
		const s = intAttr(suite.attrs.skipped);
		if (!c || seen.has(index) || t === null || f === null || s === null) return null;
		seen.add(index);
		Object.assign(c, { tests: t, failed: f, skipped: s });
		if (!finishCounts(c)) return null;
	}
	const sum = sumCounts(perInput);
	if (sum.tests !== tests || sum.failed !== failures || sum.skipped !== skipped || sum.errors !== errors) return null;
	const counts: ExecCounts = { tests, passed: tests - failures - errors - skipped, failed: failures, errors, skipped };
	return counts.passed >= 0 ? { counts, perInput } : null;
}

const NODE_TOTALS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/**
 * node JUnit for exactly ONE test file (node-test is run one file per process; see `executeRun`).
 *
 * node's JUnit tree is lossy: a test that has subtests becomes a `<testsuite>`, a `describe` with children becomes
 * a `<testsuite>`, and a `describe` without children (empty, hook-only, or only-skipped-and-todo) becomes a
 * `<testcase>` that is not a test. The two kinds are indistinguishable in the XML, and the reporter's totals
 * (`<!-- tests N -->` etc.) are global to the run, so across several files a phantom suite cannot be attributed to a
 * file. For a single file the totals are exact, so they are the source of the counts, and the XML is used to
 * attribute and to cross-check them (R3-2/R3-3):
 * - each total comment must appear exactly once (a forged duplicate makes the report invalid);
 * - `tests = pass + fail + cancelled + skipped + todo`;
 * - tree identity `tests + suites = testcases + testsuite-elements`: every test is a testcase or a testsuite and every
 *   describe is a testcase or a testsuite. A node version that changes this shape fails closed;
 * - every testcase's `file` is the selected input; an N-1 pseudo-testcase (passing, named after the input path in any
 *   normalized form: basename, relative, `./relative` or absolute) counts in
 *   node's totals but is not a test, so it is removed from them.
 * Real tests exist iff `tests` (minus pseudo-testcases) is positive: a parent with subtests always has a leaf test
 * below it, while empty/hook-only describes add to `suites` only.
 */
export function parseNodeReport(xml: string, toplevelReal: string, input: string): ParsedReport {
	const root = parseXml(xml);
	if (root?.name !== "testsuites") return null;
	const totals: Record<string, number> = {};
	for (const name of NODE_TOTALS) {
		const found = [...xml.matchAll(new RegExp(`^[ \\t]*<!-- ${name} ([0-9]{1,6}) -->[ \\t]*$`, "gm"))];
		if (found.length !== 1) return null;
		totals[name] = Number(found[0]?.[1]);
	}
	const t = (name: (typeof NODE_TOTALS)[number]): number => totals[name] ?? 0;
	if (t("tests") !== t("pass") + t("fail") + t("cancelled") + t("skipped") + t("todo")) return null;
	let testcases = 0;
	let suites = 0;
	let pseudo = 0;
	let xmlFailed = 0;
	let valid = true;
	// node names its file-level pseudo-testcase after the argv path it was given (glob result, cwd-relative:
	// `sub/e.test.mjs`, the root-level `e.test.mjs`), not after the basename; accept every normalized form of the input.
	const pseudoNames = new Set([input, `./${input}`, path.basename(input), path.resolve(toplevelReal, input)]);
	const visit = (node: XmlNode): void => {
		for (const child of node.children) {
			if (child.name === "testsuite") {
				suites++;
				visit(child);
			} else if (child.name === "testcase") {
				testcases++;
				const file = child.attrs.file;
				if (file === undefined || attribute(file, toplevelReal, [input]) !== 0) {
					valid = false;
					continue;
				}
				const todo = child.children.some(n => n.name === "skipped" && n.attrs.type === "todo");
				const skipped = child.children.some(n => n.name === "skipped");
				const failed =
					!todo &&
					(child.attrs.failure !== undefined ||
						child.children.some(n => n.name === "failure" || n.name === "error"));
				if (failed) xmlFailed++;
				else if (!skipped && pseudoNames.has(child.attrs.name ?? "")) pseudo++;
			}
		}
	};
	visit(root);
	if (!valid || t("tests") + t("suites") !== testcases + suites) return null;
	const failed = t("fail") + t("cancelled");
	const counts: ExecCounts = {
		tests: t("tests") - pseudo,
		passed: 0,
		failed,
		errors: 0,
		skipped: t("skipped") + t("todo"),
	};
	// An XML failure that node's totals do not count, or totals that do not add up: never trust the report.
	if ((xmlFailed > 0 && failed === 0) || !finishCounts(counts)) return null;
	return { counts, perInput: [{ ...counts }] };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassifyInput {
	spawn: Pick<SpawnResult, "outcome" | "exitCode" | "signal" | "groupCleanup" | "outputBytes">;
	report: ParsedReport | "missing" | "invalid";
}

/** Closed classification, first match wins (validation and runner availability are handled before the run). */
export function classify({ spawn, report }: ClassifyInput): Execution {
	const base = {
		exitCode: spawn.exitCode,
		signal: spawn.signal,
		counts: null,
		perInput: null,
		outputBytes: spawn.outputBytes,
	};
	const incomplete = (reason: string): Execution => ({ ...base, status: "incomplete", reason });
	if (spawn.outcome === "timeout" || spawn.outcome === "output_limit" || spawn.outcome === "cancelled")
		return incomplete(spawn.outcome);
	if (spawn.outcome === "spawn_failed") return incomplete("spawn_failed");
	if (spawn.outcome === "output_incomplete") return incomplete("output_incomplete");
	if (spawn.groupCleanup === "unconfirmed") return incomplete("cleanup_unconfirmed");
	if (spawn.outcome === "signaled") return incomplete("runner_crash");
	if (report === "missing") return incomplete("missing_report");
	if (report === "invalid" || report === null) return incomplete("invalid_report");
	const { counts, perInput } = report;
	const full = { ...base, counts, perInput };
	if (counts.failed + counts.errors > 0) return { ...full, status: "failed", reason: "native_failure" };
	if (spawn.exitCode !== 0) return { ...full, status: "failed", reason: "nonzero_exit" };
	if (counts.tests === 0 || counts.passed === 0) return { ...full, status: "no_tests", reason: "no_actual_passes" };
	if (perInput.some(p => p.tests - p.skipped < 1))
		return { ...full, status: "incomplete", reason: "selected_input_not_executed" };
	return { ...full, status: "passed", reason: "native_success" };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const NODE_MIN: readonly [number, number, number] = [24, 11, 1];
const REPORT_CAP = 4 * 1024 * 1024;
const LIMITATIONS = [
	"advisory only: a passing receipt is mechanical evidence, not proof of correctness",
	"gitignored non-selected source files are not part of the freshness fingerprint",
	"the repository bunfig and test preload apply to bun runs; ignored files fail closed via attribution",
	"descendants that escape the process group with setsid are not detected",
	"sparse-checkout (skip-worktree) paths count as dirty: more than 5000 of them make freshness unavailable/file_limit",
	"core.fileMode=true is pinned: on a filesystem without trustworthy exec bits tracked files can count as dirty (fail-closed, may reach file_limit)",
	"core.ignorecase=false is pinned: on a case-insensitive filesystem a tracked file whose on-disk name case differs from the index counts as changed (fail-closed)",
	"a repository-local clean/process filter (other than stock git-lfs) makes freshness unavailable/unsupported_config",
	"check-in conversions (text/eol, ident, working-tree-encoding) are covered only through stat changes of tracked files; once any git command refreshes the index, a conversion-hidden edit stays hidden (D-7), as does an edit that keeps size, mtime, ctime and inode or is made in the same second as the last index write",
];

export interface RunParams {
	files: string[];
	runner?: Runner;
	timeoutMs?: number;
}
export interface RunDeps {
	env?: NodeJS.ProcessEnv;
	limits?: FingerprintLimits;
	gitTimeoutMs?: number;
	spawnCeiling?: number;
	now?: () => number;
}
interface RunCtx {
	sessionManager: { getSessionId(): string };
}
export interface RunDetails {
	execution: Execution;
	receiptId: string | null;
	storage: StorageStatus | null;
	freshness: Freshness | null;
	runner: Runner;
	runnerVersion: string | null;
	selectedInputs: string[];
	before: Pick<SourceFingerprint, "status" | "reason" | "subreason" | "digest" | "counts"> | null;
	after: Pick<SourceFingerprint, "status" | "reason" | "subreason" | "digest" | "counts"> | null;
	warnings: string[];
	limitations: string[];
	advisoryOnly: true;
}

const fpSummary = (f: SourceFingerprint): NonNullable<RunDetails["before"]> => ({
	status: f.status,
	reason: f.reason,
	subreason: f.subreason,
	digest: f.digest,
	counts: f.counts,
});

function earlyResult(runner: Runner, status: Execution["status"], reason: string, files: string[] = []): RunDetails {
	return {
		execution: { status, reason, exitCode: null, signal: null, counts: null, perInput: null, outputBytes: 0 },
		receiptId: null,
		storage: null,
		freshness: null,
		runner,
		runnerVersion: null,
		selectedInputs: files,
		before: null,
		after: null,
		warnings: [],
		limitations: [],
		advisoryOnly: true,
	};
}

type RunnerGate = { ok: true; exe: string; version: string } | { ok: false; reason: string };

async function gateRunner(runner: Runner, env: Record<string, string>, toplevel: string): Promise<RunnerGate> {
	const name = runner === "bun-test" ? "bun" : "node";
	const missing = runner === "bun-test" ? "bun_unavailable" : "node_unavailable";
	const invalid = runner === "bun-test" ? "invalid_bun_version" : "invalid_node_version";
	const exe = await resolveExecutable(name, env.PATH);
	if (!exe) return { ok: false, reason: missing };
	const res = await boundedSpawn({
		argv: [exe, "--version"],
		cwd: toplevel,
		env,
		timeoutMs: 5000,
		mode: { kind: "capture", cap: 4096 },
	});
	const m =
		res.outcome === "exited" && res.exitCode === 0
			? /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(res.stdout.toString("utf8"))
			: null;
	if (!m) return { ok: false, reason: res.outcome === "spawn_failed" ? missing : invalid };
	const version = `${m[1]}.${m[2]}.${m[3]}`;
	if (runner === "node-test") {
		const have = [Number(m[1]), Number(m[2]), Number(m[3])];
		const below = have.reduce((acc, v, i) => (acc !== 0 ? acc : Math.sign(v - (NODE_MIN[i] ?? 0))), 0) < 0;
		if (below) return { ok: false, reason: invalid };
	}
	return { ok: true, exe, version };
}

export function runnerArgv(runner: Runner, exe: string, reportFile: string, inputs: readonly string[]): string[] {
	const files = inputs.map(f => `./${f}`);
	return runner === "bun-test"
		? [exe, "test", "--reporter=junit", `--reporter-outfile=${reportFile}`, "--", ...files]
		: [exe, "--test", "--test-reporter=junit", `--test-reporter-destination=${reportFile}`, ...files];
}

const NOT_RUN: SpawnResult = {
	outcome: "exited",
	exitCode: null,
	signal: null,
	stdout: Buffer.alloc(0),
	stderrTail: "",
	outputBytes: 0,
	groupCleanup: "confirmed",
};

/** One result for classification: the first abnormal outcome wins, else the first nonzero exit. */
function mergeSpawns(list: readonly SpawnResult[]): SpawnResult {
	const abnormal = list.find(r => r.outcome !== "exited");
	const failing = list.find(r => r.exitCode !== 0 || r.signal !== null);
	return {
		...(abnormal ?? failing ?? list[0] ?? NOT_RUN),
		outputBytes: list.reduce((sum, r) => sum + r.outputBytes, 0),
		groupCleanup: list.some(r => r.groupCleanup === "unconfirmed") ? "unconfirmed" : "confirmed",
	};
}

function mergeReports(
	reports: ReadonlyArray<ParsedReport | "missing" | "invalid">,
	expected: number,
): ClassifyInput["report"] {
	if (reports.length < expected) return "missing";
	if (reports.includes("missing")) return "missing";
	const parsed: NonNullable<ParsedReport>[] = [];
	for (const r of reports) {
		if (r === "invalid" || r === null) return "invalid";
		parsed.push(r as NonNullable<ParsedReport>);
	}
	return { counts: sumCounts(parsed.map(r => r.counts)), perInput: parsed.flatMap(r => r.perInput) };
}

export async function executeRun(
	pi: CustomToolAPI,
	ctx: RunCtx,
	toolCallId: string,
	params: RunParams,
	signal: AbortSignal | undefined,
	deps: RunDeps = {},
	toolDir: string = import.meta.dir,
): Promise<RunDetails> {
	const runner: Runner = params.runner ?? "bun-test";
	const timeoutMs = params.timeoutMs ?? 60_000;
	const now = deps.now ?? Date.now;
	const bad = validateFileList(params.files, runner);
	if (bad) return earlyResult(runner, "not_run", bad);
	if (process.platform === "win32") return earlyResult(runner, "unavailable", "platform_unsupported");
	const repo = await resolveRepo(await makeGitContext(pi.cwd, deps.gitTimeoutMs, deps.env), pi.cwd);
	if (!repo.ok)
		return earlyResult(
			runner,
			"unavailable",
			repo.reason === "git_unavailable" ? "state_unavailable" : "not_a_repository",
		);
	const inputs = [...params.files].sort();
	const onDisk = await validateOnDisk(repo.toplevel, inputs);
	if (onDisk) return earlyResult(runner, "not_run", onDisk);
	const store = await openToolStore(pi, toolDir);
	if (!store.ok)
		return {
			...earlyResult(runner, "unavailable", "store_unavailable", inputs),
			storage: "store_unavailable",
			warnings: [store.reason],
		};

	const startedAt = now();
	const specDigest = sha256Hex(canonicalJson({ runner, files: inputs, timeoutMs }));
	const runnerEnv = buildEnv("runner", deps.env);
	const limits = deps.limits ?? DEFAULT_LIMITS;
	const gate = await gateRunner(runner, runnerEnv, repo.toplevel);
	const before = await fingerprint(repo.git, repo.toplevel, inputs, specDigest, limits);
	const warnings: string[] = [];
	let execution: Execution;
	let after = before;
	if (!gate.ok) {
		execution = {
			status: "unavailable",
			reason: gate.reason,
			exitCode: null,
			signal: null,
			counts: null,
			perInput: null,
			outputBytes: 0,
		};
	} else {
		const tmpBase = deps.env?.TMPDIR ?? os.tmpdir();
		const reportDir = await fs.mkdtemp(path.join(tmpBase, "skc-vr-"));
		try {
			const dirStat = await fs.lstat(reportDir);
			if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0)
				throw new Error("unsafe report dir");
			// bun: one process for all files. node: one process per file, because node's JUnit totals are global to a
			// run and only a single-file report can tell a real test from an empty/hook-only describe (R3-2/R3-3).
			const units = runner === "bun-test" ? [inputs] : inputs.map(f => [f]);
			const ceiling = deps.spawnCeiling ?? 64 * 1024 * 1024;
			const deadline = performance.now() + timeoutMs;
			const spawns: SpawnResult[] = [];
			const reports: Array<ParsedReport | "missing" | "invalid"> = [];
			for (const [i, unit] of units.entries()) {
				const reportFile = path.join(reportDir, `report-${i}.xml`);
				const used = spawns.reduce((sum, r) => sum + r.outputBytes, 0);
				const left = Math.floor(deadline - performance.now());
				const spawn =
					left < 1
						? { ...NOT_RUN, outcome: "timeout" as const }
						: await boundedSpawn({
								argv: runnerArgv(runner, gate.exe, reportFile, unit),
								cwd: repo.toplevel,
								env: runnerEnv,
								timeoutMs: left,
								mode: { kind: "drain", ceiling: Math.max(0, ceiling - used) },
								signal,
							});
				spawns.push(spawn);
				let report: ParsedReport | "missing" | "invalid" = "missing";
				if (spawn.outcome === "exited") {
					try {
						const text = (await readCapped(fs, reportFile, REPORT_CAP, true)).toString("utf8");
						report =
							(runner === "bun-test"
								? parseBunReport(text, repo.toplevel, unit)
								: parseNodeReport(text, repo.toplevel, unit[0] ?? "")) ?? "invalid";
					} catch (error) {
						report = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
					}
				}
				reports.push(report);
				if (spawn.outcome !== "exited") break; // abnormal end: the remaining files were not run
			}
			after = await fingerprint(repo.git, repo.toplevel, inputs, specDigest, limits);
			const spawned = mergeSpawns(spawns);
			const report = mergeReports(reports, units.length);
			execution = classify({ spawn: spawned, report });
		} finally {
			await fs.rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
			if (await fs.lstat(reportDir).catch(() => null)) warnings.push("report_cleanup_failed");
		}
	}
	const finishedAt = now();
	const receipt: Receipt = {
		schemaVersion: 1,
		plugin: PLUGIN_NAME,
		pluginVersion: PLUGIN_VERSION,
		id: crypto.randomUUID(),
		runner,
		runnerVersion: gate.ok ? gate.version : "unavailable",
		repositoryDigest: repo.repoDigest,
		toolCallDigest: sha256Hex(toolCallId),
		sessionDigest: sha256Hex(ctx.sessionManager.getSessionId()),
		startedAt,
		finishedAt,
		durationMs: Math.max(0, finishedAt - startedAt),
		specDigest,
		selectedInputs: inputs,
		before,
		after,
		freshness: runFreshness(before, after),
		execution,
		advisoryOnly: true,
		limitations: LIMITATIONS,
	};
	const storage = await storeReceipt(fs, store.storeRoot, receipt);
	if (after.sourceDigest) {
		const written = await writeSnapshotEvent(store, repo.repoDigest, receipt.sessionDigest, {
			at: finishedAt,
			sourceDigest: after.sourceDigest,
			head: after.head,
			by: "run",
		});
		if (!written) warnings.push("snapshot_write_dropped");
	}
	return {
		execution,
		receiptId: storage === "stored" ? receipt.id : null,
		storage,
		freshness: receipt.freshness,
		runner,
		runnerVersion: receipt.runnerVersion,
		selectedInputs: inputs,
		before: fpSummary(before),
		after: fpSummary(after),
		warnings,
		limitations: LIMITATIONS,
		advisoryOnly: true,
	};
}

// ---------------------------------------------------------------------------
// Gate evaluation (pure)
// ---------------------------------------------------------------------------

export interface ChangedSet {
	ok: boolean;
	files: string[];
}
export interface ReceiptFact {
	receipt: Receipt;
	freshNow: "fresh" | "stale" | "unavailable";
}
export interface GateEvalInput {
	gates: readonly OpenGate[];
	sourceDigest: string | null;
	snapshots: ReadonlyArray<{ at: number; sourceDigest: string }>;
	receipts: readonly ReceiptFact[];
	/** gate id -> changed test files since its baseline; absent means unavailable. */
	changed: ReadonlyMap<string, ChangedSet>;
	/** gates left unevaluated because the loop budget ended. */
	skipped?: ReadonlySet<string>;
}
export interface GateEval {
	id: string;
	gapKinds: GapKind[];
	resolution: "no_change" | "receipts" | null;
	resolvedReceiptIds: string[];
	uncovered: string[];
	terminalAt: number | null;
	jobsTotal: number;
	jobsTerminal: number;
}

/** Terminal observation rules for complete, partial and queued-resume gates. */
export function terminalAtOf(g: OpenGate): number | null {
	const resume = g.key.startsWith("resume:");
	const times = g.jobs.map(j => j[4]);
	const allTerminal = g.jobs.length > 0 && g.jobs.every(j => j[3] === 1);
	const maxJob = allTerminal ? Math.max(...times.map(t => t ?? 0)) : null;
	if (resume) {
		const sub = g.subState;
		if (!sub || !TERMINAL.has(sub)) return null;
		const attachedOk = g.jobs.length === 0 ? sub === "cancelled" : allTerminal;
		const floor = g.jobs.length === 0 ? (g.subStateAt ?? 0) : (maxJob ?? 0);
		return attachedOk && g.quiescentAt !== null && g.quiescentAt >= floor ? g.quiescentAt : null;
	}
	if (maxJob === null) return null;
	if (g.jobSetComplete) return maxJob;
	return g.quiescentAt !== null && g.quiescentAt >= maxJob ? g.quiescentAt : null;
}

function receiptGap(r: Receipt, freshNow: ReceiptFact["freshNow"]): GapKind {
	const s = r.execution.status;
	if (s === "failed") return "receipt_not_passed";
	if (s === "no_tests") return "receipt_no_tests";
	if (s !== "passed") return "receipt_incomplete";
	if (r.freshness === "changed_during_run") return "receipt_changed_during_run";
	if (r.freshness !== "fresh" || freshNow === "unavailable") return "receipt_freshness_unavailable";
	return "receipt_stale";
}

export function evaluateGates(input: GateEvalInput): GateEval[] {
	return input.gates.map((g): GateEval => {
		const out: GateEval = {
			id: g.id,
			gapKinds: [],
			resolution: null,
			resolvedReceiptIds: [],
			uncovered: [],
			terminalAt: null,
			jobsTotal: g.jobs.length,
			jobsTerminal: g.jobs.filter(j => j[3] === 1).length,
		};
		if (input.skipped?.has(g.id)) return { ...out, gapKinds: ["budget_exhausted"] };
		const terminalAt = terminalAtOf(g);
		if (terminalAt === null) {
			return {
				...out,
				gapKinds:
					g.jobSetComplete && !g.key.startsWith("resume:")
						? ["delegation_terminal_unobserved"]
						: ["delegation_terminal_unobserved", "delegation_job_set_partial"],
			};
		}
		out.terminalAt = terminalAt;
		const t0 = g.baselineSource === "before_hook" ? g.baselineAt : g.toolCallAt;
		// The newest observation at or before T0 must equal the current source state.
		const atT0 = t0
			? input.snapshots
					.filter(s => s.at <= t0)
					.reduce<{ at: number; sourceDigest: string } | null>((a, s) => (a && a.at >= s.at ? a : s), null)
			: null;
		if (atT0 && input.sourceDigest && atT0.sourceDigest === input.sourceDigest)
			return { ...out, resolution: "no_change" };
		const candidates = input.receipts.filter(f => f.receipt.startedAt >= terminalAt).slice(0, 8);
		const newest = candidates[0];
		if (!newest) return { ...out, gapKinds: ["no_receipt_after_terminal"] };
		const qualifying = candidates.filter(
			f => f.receipt.execution.status === "passed" && f.receipt.freshness === "fresh" && f.freshNow === "fresh",
		);
		if (qualifying.length === 0) return { ...out, gapKinds: [receiptGap(newest.receipt, newest.freshNow)] };
		const changed = input.changed.get(g.id);
		if (!changed?.ok) return { ...out, gapKinds: ["changed_set_unavailable"] };
		const covered = new Set(qualifying.flatMap(f => f.receipt.selectedInputs));
		const uncovered = changed.files.filter(f => !covered.has(f));
		if (uncovered.length > 0)
			return { ...out, gapKinds: ["changed_test_uncovered"], uncovered: uncovered.slice(0, 20) };
		return { ...out, resolution: "receipts", resolvedReceiptIds: qualifying.slice(0, 8).map(f => f.receipt.id) };
	});
}

export default function verificationRunTool(pi: CustomToolAPI) {
	const z = pi.zod;
	return {
		name: "verification_run",
		label: "Verification Run",
		description:
			"Run 1-32 explicit repo-relative test files with bun test (default) or node --test, attribute results per file, and store an immutable private receipt bound to before/after freshness fingerprints. No globs, no commands. Advisory only.",
		strict: true,
		concurrency: "exclusive" as const,
		parameters: z.strictObject({
			files: z.array(z.string()).describe("explicit repo-relative test file paths (1-32)"),
			runner: z.enum(["bun-test", "node-test"]).optional().describe("test runner, default bun-test"),
			timeoutMs: z.number().int().min(1000).max(120000).optional().describe("runner timeout in ms, default 60000"),
		}),
		async execute(toolCallId: string, params: RunParams, _onUpdate: unknown, ctx: RunCtx, signal?: AbortSignal) {
			try {
				return jsonResult(await executeRun(pi, ctx, toolCallId, params, signal));
			} catch (error) {
				pi.logger.warn("verification_run failed", { error: String(error) });
				return jsonResult(earlyResult(params.runner ?? "bun-test", "incomplete", "state_unavailable"));
			}
		},
	};
}
