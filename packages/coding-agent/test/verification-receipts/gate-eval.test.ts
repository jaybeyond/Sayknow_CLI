import { describe, expect, it } from "bun:test";
import type { JobTuple, OpenGate } from "../../bundles/verification-receipts/hooks/verification-baseline";
import type { Receipt } from "../../bundles/verification-receipts/hooks/verification-gate";
import {
	type ChangedSet,
	evaluateGates,
	type GateEvalInput,
	type ReceiptFact,
	terminalAtOf,
} from "../../bundles/verification-receipts/tools/verification-run";

const hex = (c: string) => c.repeat(16);
const tuple = (
	id: string,
	terminalAt: number | null,
	state = terminalAt === null ? "running" : "completed",
): JobTuple => [hex(id), hex("s"), state, terminalAt === null ? 0 : 1, terminalAt, "subagent"];
function gate(over: Partial<OpenGate> = {}): OpenGate {
	return {
		id: hex("1"),
		key: `task:${hex("2")}`,
		trigger: "task_launch",
		origin: "hook",
		openedAt: 1000,
		toolCallAt: 1000,
		baselineHead: null,
		baselineSource: "before_hook",
		baselineAt: 990,
		subagentDigest: null,
		priorJobDigest: null,
		expectedJobs: 1,
		jobSetComplete: true,
		quiescentAt: null,
		isolated: false,
		lastGapMask: 0,
		loopRuns: 0,
		jobs: [tuple("a", 2000)],
		subState: null,
		subStateAt: null,
		...over,
	};
}
function receipt(
	over: {
		startedAt?: number;
		status?: Receipt["execution"]["status"];
		freshness?: Receipt["freshness"];
		inputs?: string[];
		id?: string;
	} = {},
): Receipt {
	return {
		id: over.id ?? "00000000-0000-4000-8000-000000000001",
		startedAt: over.startedAt ?? 3000,
		freshness: over.freshness ?? "fresh",
		selectedInputs: over.inputs ?? ["a.test.ts"],
		execution: {
			status: over.status ?? "passed",
			reason: "x",
			exitCode: 0,
			signal: null,
			counts: null,
			perInput: null,
			outputBytes: 0,
		},
	} as unknown as Receipt;
}
const fact = (r: Receipt, freshNow: ReceiptFact["freshNow"] = "fresh"): ReceiptFact => ({ receipt: r, freshNow });
const changed = (files: string[], ok = true) => new Map<string, ChangedSet>([[hex("1"), { ok, files }]]);
function evalOne(over: Partial<GateEvalInput> & { gate?: OpenGate } = {}) {
	const g = over.gate ?? gate();
	return evaluateGates({
		gates: [g],
		sourceDigest: "D1",
		snapshots: [],
		receipts: [],
		changed: changed([]),
		...over,
	})[0]!;
}

describe("terminalAtOf", () => {
	it("complete set: max first-terminal time; any running job means not terminal", () => {
		expect(terminalAtOf(gate({ jobs: [tuple("a", 2000), tuple("b", 2500)] }))).toBe(2500);
		expect(terminalAtOf(gate({ jobs: [tuple("a", 2000), tuple("b", null)] }))).toBeNull();
		expect(terminalAtOf(gate({ jobs: [] }))).toBeNull();
	});
	it("partial set needs quiescence at or after the max terminal time", () => {
		const partial = gate({ jobSetComplete: false });
		expect(terminalAtOf(partial)).toBeNull();
		expect(terminalAtOf({ ...partial, quiescentAt: 1999 })).toBeNull();
		expect(terminalAtOf({ ...partial, quiescentAt: 2600 })).toBe(2600);
	});
	it("queued resume: needs a terminal newest observation, attached jobs all terminal, and quiescence", () => {
		const resume = gate({
			key: `resume:${hex("s")}:${hex("t")}`,
			trigger: "subagent_resume",
			jobSetComplete: false,
			jobs: [],
			subagentDigest: hex("s"),
			priorJobDigest: hex("p"),
			subState: "queued",
			subStateAt: 1500,
		});
		expect(terminalAtOf(resume)).toBeNull();
		expect(terminalAtOf({ ...resume, subState: "cancelled", subStateAt: 1800, quiescentAt: 1700 })).toBeNull();
		expect(terminalAtOf({ ...resume, subState: "cancelled", subStateAt: 1800, quiescentAt: 1900 })).toBe(1900);
		expect(terminalAtOf({ ...resume, subState: "completed", subStateAt: 1800, quiescentAt: 1900 })).toBeNull();
		const attached = {
			...resume,
			jobs: [tuple("n", 2200)],
			subState: "completed",
			subStateAt: 2200,
			quiescentAt: 2300,
		};
		expect(terminalAtOf(attached)).toBe(2300);
		expect(terminalAtOf({ ...attached, jobs: [tuple("n", null)] })).toBeNull();
	});
});

describe("evaluateGates", () => {
	it("reports terminal_unobserved while jobs run, plus job_set_partial when the set is incomplete", () => {
		expect(evalOne({ gate: gate({ jobs: [tuple("a", null)] }) }).gapKinds).toEqual([
			"delegation_terminal_unobserved",
		]);
		expect(evalOne({ gate: gate({ jobs: [tuple("a", 2000)], jobSetComplete: false }) }).gapKinds).toEqual([
			"delegation_terminal_unobserved",
			"delegation_job_set_partial",
		]);
	});
	it("no receipt after terminal -> no_receipt_after_terminal; a receipt from before terminal does not count", () => {
		expect(evalOne().gapKinds).toEqual(["no_receipt_after_terminal"]);
		expect(evalOne({ receipts: [fact(receipt({ startedAt: 1999 }))] }).gapKinds).toEqual([
			"no_receipt_after_terminal",
		]);
	});
	it("maps the newest receipt's state to its gap kind", () => {
		const cases: Array<[Partial<Parameters<typeof receipt>[0]>, ReceiptFact["freshNow"], string]> = [
			[{ status: "failed" }, "fresh", "receipt_not_passed"],
			[{ status: "no_tests" }, "fresh", "receipt_no_tests"],
			[{ status: "incomplete" }, "fresh", "receipt_incomplete"],
			[{ status: "unavailable" }, "fresh", "receipt_incomplete"],
			[{ freshness: "changed_during_run" }, "fresh", "receipt_changed_during_run"],
			[{ freshness: "unavailable" }, "fresh", "receipt_freshness_unavailable"],
			[{}, "unavailable", "receipt_freshness_unavailable"],
			[{}, "stale", "receipt_stale"],
		];
		for (const [over, freshNow, kind] of cases)
			expect(evalOne({ receipts: [fact(receipt(over), freshNow)] }).gapKinds).toEqual([kind as never]);
	});
	it("resolves with receipts when a fresh passed receipt covers every changed test", () => {
		const r = evalOne({ receipts: [fact(receipt())], changed: changed(["a.test.ts"]) });
		expect(r).toMatchObject({
			resolution: "receipts",
			gapKinds: [],
			resolvedReceiptIds: ["00000000-0000-4000-8000-000000000001"],
		});
	});
	it("an older passing receipt qualifies even if the newest failed; coverage unions across receipts", () => {
		const newest = receipt({ startedAt: 4000, status: "failed", id: "00000000-0000-4000-8000-000000000002" });
		const a = receipt({ startedAt: 3000, inputs: ["a.test.ts"], id: "00000000-0000-4000-8000-000000000003" });
		const b = receipt({ startedAt: 3500, inputs: ["b.test.ts"], id: "00000000-0000-4000-8000-000000000004" });
		const r = evalOne({ receipts: [fact(newest), fact(b), fact(a)], changed: changed(["a.test.ts", "b.test.ts"]) });
		expect(r.resolution).toBe("receipts");
		expect(r.resolvedReceiptIds).toHaveLength(2);
	});
	it("lists changed tests nobody covered (max 20) and fails closed when the changed set is unavailable", () => {
		const many = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, "0")}.test.ts`);
		const r = evalOne({ receipts: [fact(receipt())], changed: changed(many) });
		expect(r.gapKinds).toEqual(["changed_test_uncovered"]);
		expect(r.uncovered).toHaveLength(20);
		expect(evalOne({ receipts: [fact(receipt())], changed: changed([], false) }).gapKinds).toEqual([
			"changed_set_unavailable",
		]);
		expect(evalOne({ receipts: [fact(receipt())], changed: new Map() }).gapKinds).toEqual([
			"changed_set_unavailable",
		]);
	});
	it("no_change needs the newest snapshot at or before T0 to equal the current source", () => {
		const snaps = (list: Array<[number, string]>) => list.map(([at, sourceDigest]) => ({ at, sourceDigest }));
		expect(evalOne({ snapshots: snaps([[900, "D1"]]) }).resolution).toBe("no_change");
		// state changed (D2 observed) after the older matching snapshot but before T0 -> not unchanged
		expect(
			evalOne({
				snapshots: snaps([
					[500, "D1"],
					[900, "D2"],
				]),
			}).gapKinds,
		).toEqual(["no_receipt_after_terminal"]);
		expect(evalOne({ snapshots: snaps([[995, "D1"]]) }).gapKinds).toEqual(["no_receipt_after_terminal"]);
		expect(evalOne({ snapshots: snaps([[900, "D1"]]), sourceDigest: null }).gapKinds).toEqual([
			"no_receipt_after_terminal",
		]);
	});
	it("T0 is baselineAt for before_hook gates and toolCallAt otherwise; unknown T0 never yields no_change", () => {
		const snaps = [{ at: 995, sourceDigest: "D1" }];
		expect(evalOne({ snapshots: snaps, gate: gate({ baselineAt: 990 }) }).resolution).toBeNull();
		expect(
			evalOne({ snapshots: snaps, gate: gate({ baselineSource: "none", baselineAt: null, toolCallAt: 996 }) })
				.resolution,
		).toBe("no_change");
		expect(
			evalOne({ snapshots: snaps, gate: gate({ baselineSource: "none", baselineAt: null, toolCallAt: 0 }) })
				.resolution,
		).toBeNull();
	});
	it("skipped gates report budget_exhausted and nothing resolves", () => {
		const g = gate();
		const [r] = evaluateGates({
			gates: [g],
			sourceDigest: "D1",
			snapshots: [{ at: 1, sourceDigest: "D1" }],
			receipts: [],
			changed: new Map(),
			skipped: new Set([g.id]),
		});
		expect(r).toMatchObject({ gapKinds: ["budget_exhausted"], resolution: null });
	});
	it("an unknown status never counts as terminal", () => {
		expect(
			evalOne({ gate: gate({ jobs: [[hex("a"), hex("s"), "weird", 0, null, "subagent"]] }) }).gapKinds,
		).toContain("delegation_terminal_unobserved");
	});
});
