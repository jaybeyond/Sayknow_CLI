import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	classify,
	executeRun,
	parseBunReport,
	parseNodeReport,
	parseXml,
	runnerArgv,
} from "../../bundles/verification-receipts/tools/verification-run";
import { resolveExecutable } from "../../bundles/verification-receipts/tools/verification-status";
import { cleanupTemps, FAIL_TEST, git, mkEnv, mkPi, mkRepo, mkTemp, PASS_TEST, write } from "./helpers";

afterEach(cleanupTemps);

const TOP = "/repo";
const bunXml = (suites: string, root = 'tests="3" failures="1" skipped="1"') =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" ${root} time="0.01">\n${suites}</testsuites>\n`;
const suite = (file: string, tests: number, failures: number, skipped: number) =>
	`  <testsuite name="${file}" file="${file}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="0.01"></testsuite>\n`;

describe("parseXml", () => {
	it("parses attributes, entities and nesting; rejects malformed documents", () => {
		const root = parseXml(`<a x="1 &amp; 2"><b/><c y='z'></c></a>`);
		expect(root?.attrs.x).toBe("1 & 2");
		expect(root?.children.map(c => c.name)).toEqual(["b", "c"]);
		expect(parseXml("<a><b></a>")).toBeNull();
		expect(parseXml("<a></a><a></a>")).toBeNull();
		expect(parseXml("<a x=1></a>")).toBeNull();
		expect(parseXml("<a x='1' x='2'/>")).toBeNull();
		expect(parseXml("text<a/>")).toBeNull();
		expect(parseXml("")).toBeNull();
	});
});

describe("parseBunReport", () => {
	const inputs = ["a.test.ts", "nested/b.test.ts"];
	it("attributes counts per selected file and checks the root totals", () => {
		const parsed = parseBunReport(
			bunXml(suite("a.test.ts", 2, 1, 0) + suite("nested/b.test.ts", 1, 0, 1)),
			TOP,
			inputs,
		);
		expect(parsed?.counts).toEqual({ tests: 3, passed: 1, failed: 1, errors: 0, skipped: 1 });
		expect(parsed?.perInput[0]).toEqual({ tests: 2, passed: 1, failed: 1, errors: 0, skipped: 0 });
		expect(parsed?.perInput[1]?.skipped).toBe(1);
	});
	it("accepts absolute suite paths and leaves absent files at zero", () => {
		const xml = bunXml(suite(`${TOP}/a.test.ts`, 3, 1, 1));
		const parsed = parseBunReport(xml, TOP, inputs);
		expect(parsed?.perInput[1]).toEqual({ tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 });
	});
	it("returns null for unknown files, duplicates, mismatched totals and non-integer counts", () => {
		expect(parseBunReport(bunXml(suite("other.test.ts", 3, 1, 1)), TOP, inputs)).toBeNull();
		expect(parseBunReport(bunXml(suite("a.test.ts", 2, 1, 0) + suite("a.test.ts", 1, 0, 1)), TOP, inputs)).toBeNull();
		expect(parseBunReport(bunXml(suite("a.test.ts", 2, 1, 0)), TOP, inputs)).toBeNull();
		expect(
			parseBunReport(bunXml(suite("a.test.ts", 3, 1, 1), 'tests="x" failures="1" skipped="1"'), TOP, inputs),
		).toBeNull();
		expect(parseBunReport("<testsuite/>", TOP, inputs)).toBeNull();
		expect(parseBunReport("garbage", TOP, inputs)).toBeNull();
	});
});

describe("parseNodeReport (single file; XML shapes captured from real node 24 --test-reporter=junit)", () => {
	const IN = "a.test.mjs";
	const F = `file="${TOP}/${IN}"`;
	const totals = (t: {
		tests: number;
		suites: number;
		pass: number;
		fail?: number;
		cancelled?: number;
		skipped?: number;
		todo?: number;
	}) =>
		`\t<!-- tests ${t.tests} -->\n\t<!-- suites ${t.suites} -->\n\t<!-- pass ${t.pass} -->\n\t<!-- fail ${t.fail ?? 0} -->\n` +
		`\t<!-- cancelled ${t.cancelled ?? 0} -->\n\t<!-- skipped ${t.skipped ?? 0} -->\n\t<!-- todo ${t.todo ?? 0} -->\n\t<!-- duration_ms 31.9 -->\n`;
	const wrap = (body: string, t: Parameters<typeof totals>[0]) =>
		`<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}${totals(t)}</testsuites>\n`;
	const suite = (name: string, inner: string, tests = 1, skipped = 0) =>
		`\t<testsuite name="${name}" time="0.000401" disabled="0" errors="0" tests="${tests}" failures="0" skipped="${skipped}" hostname="h">\n${inner}\t</testsuite>\n`;
	const tc = (name: string, inner = "", attrs = "") =>
		inner === ""
			? `\t<testcase name="${name}" time="0.000183" classname="test" ${F}${attrs}/>\n`
			: `\t<testcase name="${name}" time="0.000183" classname="test" ${F}${attrs}>\n${inner}\t</testcase>\n`;
	const parse = (xml: string) => parseNodeReport(xml, TOP, IN);

	it("R3-3: a test with a subtest (testsuite > testcase, tests 2) counts both and has real tests", () => {
		const parsed = parse(wrap(suite("outer", tc("inner")), { tests: 2, suites: 0, pass: 2 }));
		expect(parsed?.counts).toEqual({ tests: 2, passed: 2, failed: 0, errors: 0, skipped: 0 });
		expect(parsed?.perInput).toEqual([parsed?.counts as never]);
	});
	it("R3-3: nested subtests (testsuite > testsuite > testcase, tests 3)", () => {
		const parsed = parse(wrap(suite("o", suite("i", tc("deep"))), { tests: 3, suites: 0, pass: 3 }));
		expect(parsed?.counts).toMatchObject({ tests: 3, passed: 3 });
	});
	it("a describe with tests (testsuite, suites 1) counts only its tests", () => {
		const parsed = parse(wrap(suite("d", tc("a") + tc("b"), 2), { tests: 2, suites: 1, pass: 2 }));
		expect(parsed?.counts).toMatchObject({ tests: 2, passed: 2 });
	});
	it("N-3: an empty or hook-only describe is a testcase that is not a test (tests 0, suites 1)", () => {
		const parsed = parse(wrap(tc("nothing"), { tests: 0, suites: 1, pass: 0 }));
		expect(parsed?.counts).toEqual({ tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 });
	});
	it("N-3: skipped / todo describes and tests inside a describe are skipped, never passes", () => {
		const skipped =
			tc("a", '\t\t<skipped type="skipped" message="true"/>\n') +
			tc("b", '\t\t<skipped type="todo" message="true"/>\n');
		const parsed = parse(wrap(suite("s", skipped, 2, 2), { tests: 2, suites: 1, pass: 0, skipped: 1, todo: 1 }));
		expect(parsed?.counts).toEqual({ tests: 2, passed: 0, failed: 0, errors: 0, skipped: 2 });
		const describeSkip = tc("s", '\t\t<skipped type="skipped" message="true"/>\n');
		expect(parse(wrap(describeSkip, { tests: 0, suites: 1, pass: 0 }))?.counts.tests).toBe(0);
	});
	it("a nested empty describe next to a real test does not add a test", () => {
		const parsed = parse(wrap(suite("o", tc("a") + tc("inner"), 2), { tests: 1, suites: 2, pass: 1 }));
		expect(parsed?.counts).toMatchObject({ tests: 1, passed: 1 });
	});
	it("N-1: the basename pseudo-testcase of an empty file is not a test", () => {
		const parsed = parse(wrap(tc(IN), { tests: 1, suites: 0, pass: 1 }));
		expect(parsed?.counts).toEqual({ tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 });
	});
	it("R4-1: the pseudo-testcase of an empty file is recognised under every normalized form of the input path", () => {
		for (const [input, name] of [
			["sub/e.test.mjs", "sub/e.test.mjs"], // what node really emits for ./sub/e.test.mjs
			["sub/e.test.mjs", "e.test.mjs"],
			["sub/e.test.mjs", "./sub/e.test.mjs"],
			["sub/e.test.mjs", `${TOP}/sub/e.test.mjs`],
			["a/b/c.test.mjs", "a/b/c.test.mjs"],
		] as const) {
			const xml = wrap(`\t<testcase name="${name}" time="0.02" classname="test" file="${TOP}/${input}"/>\n`, {
				tests: 1,
				suites: 0,
				pass: 1,
			});
			expect(parseNodeReport(xml, TOP, input)?.counts).toEqual({
				tests: 0,
				passed: 0,
				failed: 0,
				errors: 0,
				skipped: 0,
			});
		}
	});
	it("R4-1: a real test with another name in a nested file stays a test; a failing or skipped path-named case is not discounted", () => {
		const nested = "sub/p.test.mjs";
		const NF = `file="${TOP}/${nested}"`;
		const mk = (name: string, inner = "", attrs = "") =>
			`\t<testcase name="${name}" time="0.1" classname="test" ${NF}${attrs}${inner ? `>\n${inner}\t</testcase>\n` : "/>\n"}`;
		const real = wrap(mk("p"), { tests: 1, suites: 0, pass: 1 });
		expect(parseNodeReport(real, TOP, nested)?.counts).toMatchObject({ tests: 1, passed: 1 });
		const failing = wrap(mk(nested, '\t\t<failure type="x" message="m">e</failure>\n', ' failure="x"'), {
			tests: 1,
			suites: 0,
			pass: 0,
			fail: 1,
		});
		expect(parseNodeReport(failing, TOP, nested)?.counts).toMatchObject({ tests: 1, failed: 1 });
		const skipped = wrap(mk(nested, '\t\t<skipped type="skipped" message="true"/>\n'), {
			tests: 1,
			suites: 0,
			pass: 0,
			skipped: 1,
		});
		expect(parseNodeReport(skipped, TOP, nested)?.counts).toMatchObject({ tests: 1, skipped: 1, passed: 0 });
	});
	it("N-1: a failing basename testcase (syntax error) is still a failure", () => {
		const failing = tc(IN, '\t\t<failure type="x" message="m">e</failure>\n', ' failure="test failed"');
		expect(parse(wrap(failing, { tests: 1, suites: 0, pass: 0, fail: 1 }))?.counts).toMatchObject({
			tests: 1,
			failed: 1,
		});
	});
	it("N-2: todo plus failure counts as one skipped test", () => {
		const todo = tc(
			"t",
			'\t\t<skipped type="todo" message="t"/>\n\t\t<failure type="x" message="m">e</failure>\n',
			' failure="m"',
		);
		expect(parse(wrap(todo, { tests: 1, suites: 0, pass: 0, todo: 1 }))?.counts).toEqual({
			tests: 1,
			passed: 0,
			failed: 0,
			errors: 0,
			skipped: 1,
		});
	});
	it("a cancelled test (hook failure) and a failing parent with passing subtests are failures", () => {
		const cancelled = suite(
			"h",
			tc("a", '\t\t<failure type="cancelledByParent" message="c">e</failure>\n', ' failure="c"'),
		);
		expect(parse(wrap(cancelled, { tests: 1, suites: 1, pass: 0, cancelled: 1 }))?.counts).toMatchObject({
			failed: 1,
		});
		// the parent fails after a passing subtest: no <failure> element anywhere, only the totals show it
		expect(parse(wrap(suite("o", tc("i")), { tests: 2, suites: 0, pass: 1, fail: 1 }))?.counts).toMatchObject({
			tests: 2,
			passed: 1,
			failed: 1,
		});
	});
	it("returns null when file attribution is missing or points at another file", () => {
		expect(parse(wrap('\t<testcase name="x"/>\n', { tests: 1, suites: 0, pass: 1 }))).toBeNull();
		expect(parse(wrap(tc("x").replace(IN, "zzz.test.mjs"), { tests: 1, suites: 0, pass: 1 }))).toBeNull();
	});
	it("fails closed when the totals and the tree do not agree (node format drift or forged comments)", () => {
		const ok = wrap(tc("x"), { tests: 1, suites: 0, pass: 1 });
		expect(parse(ok)).not.toBeNull();
		expect(parse(ok.replace("<!-- suites 0 -->", "<!-- suites 1 -->"))).toBeNull(); // tests + suites != nodes
		expect(parse(wrap(tc("x"), { tests: 2, suites: 0, pass: 2 }))).toBeNull(); // more tests than nodes
		expect(parse(wrap(suite("o", tc("i")), { tests: 1, suites: 0, pass: 1 }))).toBeNull(); // subtest parent not counted
		expect(parse(ok.replace("<!-- pass 1 -->", "<!-- pass 0 -->"))).toBeNull(); // tests != pass+fail+...
		expect(parse(ok.replace("<!-- todo 0 -->", ""))).toBeNull(); // a total is missing
		expect(parse(ok.replace("</testsuites>", "\t<!-- pass 1 -->\n</testsuites>"))).toBeNull(); // duplicated
		expect(parse(ok.replace("<!-- tests 1 -->", "<!-- tests 99999999999 -->"))).toBeNull(); // oversized
		expect(parse("<testsuite/>")).toBeNull();
		// a failure element that node's totals do not count as a failure
		const hidden = tc("x", '\t\t<failure type="x" message="m">e</failure>\n', ' failure="m"');
		expect(parse(wrap(hidden, { tests: 1, suites: 0, pass: 1 }))).toBeNull();
	});
});

describe("classify (first match wins)", () => {
	const ok = {
		outcome: "exited" as const,
		exitCode: 0,
		signal: null,
		groupCleanup: "confirmed" as const,
		outputBytes: 10,
	};
	const rep = (perInput: Array<[number, number, number]>) => {
		const per = perInput.map(([tests, failed, skipped]) => ({
			tests,
			passed: tests - failed - skipped,
			failed,
			errors: 0,
			skipped,
		}));
		const sum = (k: "tests" | "passed" | "failed" | "skipped") => per.reduce((a, p) => a + p[k], 0);
		return {
			counts: {
				tests: sum("tests"),
				passed: sum("passed"),
				failed: sum("failed"),
				errors: 0,
				skipped: sum("skipped"),
			},
			perInput: per,
		};
	};
	it("maps spawn outcomes to incomplete reasons", () => {
		for (const outcome of ["timeout", "output_limit", "cancelled", "spawn_failed", "output_incomplete"] as const) {
			expect(classify({ spawn: { ...ok, outcome, exitCode: null }, report: "missing" })).toMatchObject({
				status: "incomplete",
				reason: outcome,
			});
		}
		expect(
			classify({
				spawn: { ...ok, outcome: "signaled", exitCode: null, signal: "SIGSEGV" },
				report: rep([[1, 0, 0]]),
			}),
		).toMatchObject({ reason: "runner_crash" });
		expect(classify({ spawn: { ...ok, groupCleanup: "unconfirmed" }, report: rep([[1, 0, 0]]) })).toMatchObject({
			reason: "cleanup_unconfirmed",
		});
		expect(classify({ spawn: ok, report: "missing" })).toMatchObject({ reason: "missing_report" });
		expect(classify({ spawn: ok, report: "invalid" })).toMatchObject({ reason: "invalid_report" });
	});
	it("classifies test results", () => {
		expect(classify({ spawn: ok, report: rep([[2, 1, 0]]) })).toMatchObject({
			status: "failed",
			reason: "native_failure",
		});
		expect(classify({ spawn: { ...ok, exitCode: 1 }, report: rep([[2, 0, 0]]) })).toMatchObject({
			status: "failed",
			reason: "nonzero_exit",
		});
		expect(classify({ spawn: ok, report: rep([[0, 0, 0]]) })).toMatchObject({
			status: "no_tests",
			reason: "no_actual_passes",
		});
		expect(classify({ spawn: ok, report: rep([[2, 0, 2]]) })).toMatchObject({
			status: "no_tests",
			reason: "no_actual_passes",
		});
		expect(
			classify({
				spawn: ok,
				report: rep([
					[2, 0, 0],
					[1, 0, 1],
				]),
			}),
		).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		expect(
			classify({
				spawn: ok,
				report: rep([
					[2, 0, 0],
					[0, 0, 0],
				]),
			}),
		).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		expect(
			classify({
				spawn: ok,
				report: rep([
					[2, 0, 0],
					[1, 0, 0],
				]),
			}),
		).toMatchObject({ status: "passed", reason: "native_success" });
	});
});

describe("runnerArgv", () => {
	it("pins the exact argv shapes", () => {
		expect(runnerArgv("bun-test", "/bin/bun", "/r/report.xml", ["a.test.ts", "-x.test.ts"])).toEqual([
			"/bin/bun",
			"test",
			"--reporter=junit",
			"--reporter-outfile=/r/report.xml",
			"--",
			"./a.test.ts",
			"./-x.test.ts",
		]);
		expect(runnerArgv("node-test", "/bin/node", "/r/report.xml", ["a.test.mjs"])).toEqual([
			"/bin/node",
			"--test",
			"--test-reporter=junit",
			"--test-reporter-destination=/r/report.xml",
			"./a.test.mjs",
		]);
	});
});

async function run(
	repo: string,
	env: Awaited<ReturnType<typeof mkEnv>>,
	files: string[],
	runner: "bun-test" | "node-test" = "bun-test",
) {
	return executeRun(
		mkPi(repo, env),
		{ sessionManager: { getSessionId: () => "sess" } },
		`call-${files.join()}`,
		{ files, runner },
		undefined,
		{ env: env.env },
		env.toolsDir,
	);
}

describe("executeRun with real bun test", () => {
	it("passes, stores an immutable receipt and reports per-file counts", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "b.test.ts", PASS_TEST);
		const d = await run(repo, env, ["a.test.ts", "b.test.ts"]);
		expect(d.execution).toMatchObject({ status: "passed", reason: "native_success" });
		expect(d.execution.perInput?.map(p => p.passed)).toEqual([1, 1]);
		expect(d.freshness).toBe("fresh");
		expect(d.storage).toBe("stored");
		expect(d.receiptId).toMatch(/^[0-9a-f-]{36}$/);
		expect(d.limitations.length).toBeGreaterThan(0);
		expect(
			d.limitations.some((l: string) => l.includes("sparse-checkout") && l.includes("unavailable/file_limit")),
		).toBe(true);
		expect(d.limitations.some((l: string) => l.includes("check-in conversions") && l.includes("stat"))).toBe(true);
		const file = path.join(env.storeRoot, "receipts", "v1");
		const [repoDir] = await fs.readdir(file);
		const entries = await fs.readdir(path.join(file, repoDir as string));
		expect(entries).toEqual([`${d.receiptId}.json`]);
		const st = await fs.stat(path.join(file, repoDir as string, entries[0] as string));
		expect(st.mode & 0o777).toBe(0o600);
		expect((await fs.stat(env.storeRoot)).mode & 0o777).toBe(0o700);
	});
	it("a failing test is failed/native_failure", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "f.test.ts", FAIL_TEST);
		const d = await run(repo, env, ["a.test.ts", "f.test.ts"]);
		expect(d.execution).toMatchObject({ status: "failed", reason: "native_failure" });
		expect(d.execution.perInput?.[1]?.failed).toBe(1);
	});
	it("a skip-only file is no_tests, never passed", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "s.test.ts", `import { test } from "bun:test";\ntest.skip("x", () => {});\n`);
		const d = await run(repo, env, ["s.test.ts"]);
		expect(d.execution.status).toBe("no_tests");
	});
	it("D-2: a single empty file produces no report and is incomplete/missing_report", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "e.test.ts", "");
		const d = await run(repo, env, ["e.test.ts"]);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "missing_report" });
	});
	it("a file skipped by the repo bunfig pathIgnorePatterns is not reported as executed", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "bunfig.toml", `[test]\npathIgnorePatterns = ["ignored/**"]\n`);
		await write(repo, "ignored/x.test.ts", PASS_TEST);
		const d = await run(repo, env, ["a.test.ts", "ignored/x.test.ts"]);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		expect(d.execution.perInput?.[1]?.tests).toBe(0);
	});
	it("times out, kills the runner and records incomplete/timeout", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(
			repo,
			"slow.test.ts",
			`import { test } from "bun:test";\ntest("slow", async () => { await Bun.sleep(60_000); }, 120_000);\n`,
		);
		const d = await executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"t",
			{ files: ["slow.test.ts"], timeoutMs: 1000 },
			undefined,
			{ env: env.env },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "timeout" });
	}, 20_000);
	it("a source edit during the run marks the receipt changed_during_run", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(
			repo,
			"mut.test.ts",
			`import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\ntest("m", () => { writeFileSync(${JSON.stringify(path.join(repo, "a.ts"))}, "export const a = 2;\\n"); });\n`,
		);
		const d = await run(repo, env, ["mut.test.ts"]);
		expect(d.execution.status).toBe("passed");
		expect(d.freshness).toBe("changed_during_run");
	});
	it("a directory that is not a git repository fails closed", async () => {
		const env = await mkEnv();
		const plain = await mkTemp("skc-vr-plain-");
		await write(plain, "a.test.ts", PASS_TEST);
		const d = await run(plain, env, ["a.test.ts"]);
		expect(d.execution).toMatchObject({ status: "unavailable", reason: "not_a_repository" });
	});
});

describe("executeRun with node --test", () => {
	const NODE_PASS = `import { test } from "node:test";\nimport assert from "node:assert";\ntest("ok", () => assert.equal(1, 1));\n`;
	it("passes two files with per-file attribution", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "n1.test.mjs", NODE_PASS);
		await write(repo, "n2.test.mjs", NODE_PASS);
		const d = await run(repo, env, ["n1.test.mjs", "n2.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "passed" });
		expect(d.execution.perInput?.map(p => p.tests)).toEqual([1, 1]);
		expect(d.runnerVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});
	it("N-1: an empty file is not a pass", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "n1.test.mjs", NODE_PASS);
		await write(repo, "empty.test.mjs", "");
		const d = await run(repo, env, ["n1.test.mjs", "empty.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
	});
	it("a failing node test is failed/native_failure", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(
			repo,
			"bad.test.mjs",
			`import { test } from "node:test";\nimport assert from "node:assert";\ntest("bad", () => assert.equal(1, 2));\n`,
		);
		const d = await run(repo, env, ["bad.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "failed", reason: "native_failure" });
	});
	const EMPTY_DESCRIBE = `import { describe } from "node:test";\ndescribe("nothing", () => {});\n`;
	const HOOK_ONLY = `import { before, describe } from "node:test";\ndescribe("hooks", () => { before(() => {}); });\n`;
	const SKIP_ONLY = `import { test } from "node:test";\ntest("skipped", { skip: true }, () => {});\n`;
	it("N-3 (BLK-3): a file with only an empty describe is no_tests/no_actual_passes, never passed", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "d.test.mjs", EMPTY_DESCRIBE);
		const d = await run(repo, env, ["d.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "no_tests", reason: "no_actual_passes" });
		expect(d.execution.counts).toMatchObject({ tests: 0, passed: 0 });
	});
	it("N-3 (BLK-3): a hook-only describe is no_tests/no_actual_passes", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "h.test.mjs", HOOK_ONLY);
		const d = await run(repo, env, ["h.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "no_tests", reason: "no_actual_passes" });
	});
	it("N-3 (BLK-3): [pass, empty-describe] and [pass, hook-only] are incomplete/selected_input_not_executed", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "p.test.mjs", NODE_PASS);
		await write(repo, "d.test.mjs", EMPTY_DESCRIBE);
		await write(repo, "h.test.mjs", HOOK_ONLY);
		for (const other of ["d.test.mjs", "h.test.mjs"]) {
			const d = await run(repo, env, ["p.test.mjs", other], "node-test");
			expect(d.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		}
	});
	it("N-3: an empty describe next to a real test in the same file does not hide the real test", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(
			repo,
			"m.test.mjs",
			`${NODE_PASS}import { describe } from "node:test";\ndescribe("nothing", () => {});\n`,
		);
		const d = await run(repo, env, ["m.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "passed", reason: "native_success" });
		expect(d.execution.counts).toMatchObject({ tests: 1, passed: 1 });
	});
	it("AC8: a node skip-only file is no_tests/no_actual_passes", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "s.test.mjs", SKIP_ONLY);
		const d = await run(repo, env, ["s.test.mjs"], "node-test");
		expect(d.execution).toMatchObject({ status: "no_tests", reason: "no_actual_passes" });
		expect(d.execution.counts).toMatchObject({ tests: 1, skipped: 1, passed: 0 });
	});
	it("AC8: a PATH without node is unavailable/node_unavailable and nothing runs", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "n1.test.mjs", NODE_PASS);
		const bin = path.join(env.root, "gitonly");
		await fs.mkdir(bin);
		const realGit = (await resolveExecutable("git", process.env.PATH)) as string;
		await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
		const d = await executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"t",
			{ files: ["n1.test.mjs"], runner: "node-test" },
			undefined,
			{ env: { ...env.env, PATH: bin } },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "unavailable", reason: "node_unavailable" });
		expect(d.execution.counts).toBeNull();
	});
	it("a node older than NODE_MIN is unavailable/invalid_node_version", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, "n1.test.mjs", NODE_PASS);
		const bin = path.join(env.root, "fakebin");
		await fs.mkdir(bin);
		await fs.writeFile(path.join(bin, "node"), "#!/bin/sh\necho v22.23.3\n", { mode: 0o755 });
		const d = await executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"t",
			{ files: ["n1.test.mjs"], runner: "node-test" },
			undefined,
			{ env: { ...env.env, PATH: `${bin}:${process.env.PATH}` } },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "unavailable", reason: "invalid_node_version" });
	});
});

describe("executeRun with node --test: real node:test shapes (R3-2/R3-3)", () => {
	const HEAD = `import test, { before, describe, it } from "node:test";\n`;
	const FILES: Record<string, string> = {
		"sub.test.mjs": `${HEAD}test("outer", async t => { await t.test("inner", () => {}); });\n`,
		"nested.test.mjs": `${HEAD}test("o", async t => { await t.test("i", async t2 => { await t2.test("deep", () => {}); }); });\n`,
		"desc.test.mjs": `${HEAD}describe("d", () => { it("a", () => {}); it("b", () => {}); });\n`,
		"empty.test.mjs": `${HEAD}describe("nothing", () => {});\n`,
		"hook.test.mjs": `${HEAD}describe("h", () => { before(() => {}); });\n`,
		"skipd.test.mjs": `${HEAD}describe("s", () => { it.skip("a", () => {}); it.todo("b"); });\n`,
		"emptynest.test.mjs": `${HEAD}describe("o", () => { it("a", () => {}); describe("inner", () => {}); });\n`,
		"emptyfile.test.mjs": "",
		"failsub.test.mjs": `${HEAD}test("o", async t => { await t.test("i", () => { throw new Error("x"); }); });\n`,
		"failparent.test.mjs": `${HEAD}test("o", async t => { await t.test("i", () => {}); throw new Error("after"); });\n`,
	};
	const exec = async (files: string[]) => {
		const env = await mkEnv();
		const repo = await mkRepo();
		for (const [name, body] of Object.entries(FILES)) await write(repo, name, body);
		return run(repo, env, files, "node-test");
	};
	const single: Array<[string, string, string, number]> = [
		["sub.test.mjs", "passed", "native_success", 2],
		["nested.test.mjs", "passed", "native_success", 3],
		["desc.test.mjs", "passed", "native_success", 2],
		["emptynest.test.mjs", "passed", "native_success", 1],
		["empty.test.mjs", "no_tests", "no_actual_passes", 0],
		["hook.test.mjs", "no_tests", "no_actual_passes", 0],
		["skipd.test.mjs", "no_tests", "no_actual_passes", 2],
		["emptyfile.test.mjs", "no_tests", "no_actual_passes", 0],
		["failsub.test.mjs", "failed", "native_failure", 2],
		["failparent.test.mjs", "failed", "native_failure", 2],
	];
	for (const [file, status, reason, tests] of single) {
		it(`${file} alone -> ${status}/${reason}`, async () => {
			const d = await exec([file]);
			expect(d.execution).toMatchObject({ status, reason });
			expect(d.execution.counts?.tests).toBe(tests);
		});
	}
	it("liveness: subtest, nested-subtest and describe files together are passed with per-file counts", async () => {
		const d = await exec(["desc.test.mjs", "nested.test.mjs", "sub.test.mjs"]);
		expect(d.execution).toMatchObject({ status: "passed", reason: "native_success" });
		expect(d.execution.perInput?.map(p => p.tests)).toEqual([2, 3, 2]);
	});
	it("R3-2: [subtest file, empty describe file] is never passed", async () => {
		const d = await exec(["empty.test.mjs", "sub.test.mjs"]);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		expect(d.execution.perInput?.map(p => p.tests)).toEqual([0, 2]);
	});
	it("R3-2: [subtest file, hook-only describe file] and [describe-only-skipped, subtest] are never passed", async () => {
		const hook = await exec(["hook.test.mjs", "sub.test.mjs"]);
		expect(hook.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		const skipped = await exec(["skipd.test.mjs", "sub.test.mjs"]);
		expect(skipped.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
	});
	it("a failing file next to passing subtest files is failed/native_failure and every file is still attributed", async () => {
		const d = await exec(["failsub.test.mjs", "sub.test.mjs"]);
		expect(d.execution).toMatchObject({ status: "failed", reason: "native_failure" });
		expect(d.execution.perInput?.map(p => p.failed)).toEqual([2, 0]);
	});
	it("the run timeout is a whole-run budget across the per-file processes", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		const slow = `${HEAD}test("slow", async () => { await new Promise(r => setTimeout(r, 20000)); });\n`;
		await write(repo, "a.test.mjs", slow);
		await write(repo, "b.test.mjs", slow);
		const t0 = Date.now();
		const d = await executeRun(
			mkPi(repo, env),
			{ sessionManager: { getSessionId: () => "s" } },
			"t",
			{ files: ["a.test.mjs", "b.test.mjs"], runner: "node-test", timeoutMs: 1500 },
			undefined,
			{ env: env.env },
			env.toolsDir,
		);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "timeout" });
		expect(Date.now() - t0).toBeLessThan(10_000);
	});
});

describe("executeRun with node --test: nested files (R4-1, real node)", () => {
	const HEAD = `import { test } from "node:test";\n`;
	const PASSING = `${HEAD}test("p", () => {});\n`;
	const FILES: Record<string, string> = {
		"sub/p.test.mjs": PASSING,
		"deep/er/p.test.mjs": PASSING,
		"sub/e.test.mjs": "",
		"sub/i.test.mjs": HEAD,
		"sub/x.test.mjs": `${HEAD}test("one", () => {});\ntest("two", () => { process.exit(0); });\ntest("three", () => { throw new Error("never"); });\n`,
		"sub/t.test.mjs": `process.exit(0);\nimport("node:test").then(({ test }) => test("never", () => { throw new Error("x"); }));\n`,
		"e.test.mjs": "",
		"t.test.mjs": `process.exit(0);\nimport("node:test").then(({ test }) => test("never", () => { throw new Error("x"); }));\n`,
	};
	const exec = async (files: string[]) => {
		const env = await mkEnv();
		const repo = await mkRepo();
		for (const [name, body] of Object.entries(FILES)) await write(repo, name, body);
		return run(repo, env, files, "node-test");
	};
	for (const file of [
		"sub/e.test.mjs",
		"sub/i.test.mjs",
		"sub/x.test.mjs",
		"sub/t.test.mjs",
		"e.test.mjs",
		"t.test.mjs",
	]) {
		it(`${file} alone is no_tests/no_actual_passes, never passed`, async () => {
			const d = await exec([file]);
			expect(d.execution).toMatchObject({ status: "no_tests", reason: "no_actual_passes" });
			expect(d.execution.counts).toMatchObject({ tests: 0, passed: 0 });
		});
	}
	it("[sub/p, sub/e] is incomplete/selected_input_not_executed with per-file counts [0, 1]", async () => {
		const d = await exec(["sub/p.test.mjs", "sub/e.test.mjs"]);
		expect(d.execution).toMatchObject({ status: "incomplete", reason: "selected_input_not_executed" });
		expect(d.execution.perInput?.map(p => p.tests)).toEqual([0, 1]);
	});
	it("liveness: nested real passing files (one and two levels deep) are passed", async () => {
		const one = await exec(["sub/p.test.mjs"]);
		expect(one.execution).toMatchObject({ status: "passed", reason: "native_success" });
		expect(one.execution.counts).toMatchObject({ tests: 1, passed: 1 });
		const both = await exec(["deep/er/p.test.mjs", "sub/p.test.mjs"]);
		expect(both.execution).toMatchObject({ status: "passed", reason: "native_success" });
		expect(both.execution.perInput?.map(p => p.tests)).toEqual([1, 1]);
	});
});

describe("executeRun: freshness in a clean repository (R4-3)", () => {
	it("a passing run is fresh in a repository with conversion attributes, committed this very second", async () => {
		const env = await mkEnv();
		const repo = await mkRepo();
		await write(repo, ".gitattributes", "* text=auto eol=lf\n");
		await fs.writeFile(path.join(repo, "data.txt"), "a\r\nb\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "attrs");
		const d = await run(repo, env, ["a.test.ts"]);
		expect(d.execution.status).toBe("passed");
		expect(d.freshness).toBe("fresh");
		expect(d.before?.digest).toBe(d.after?.digest as string);
		expect(d.before?.counts.dirtyPaths).toBe(0);
	});
});
