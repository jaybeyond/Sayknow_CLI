import { describe, expect, test } from "bun:test";
import { DEFAULT_ULTRAGOAL_OBJECTIVE } from "../../src/skc-runtime/goal-mode-request";
import { isKnownUltragoalObjective } from "../../src/skc-runtime/ultragoal-guard";

describe("isKnownUltragoalObjective", () => {
	test("accepts only the exact default aggregate objective", () => {
		expect(isKnownUltragoalObjective(DEFAULT_ULTRAGOAL_OBJECTIVE)).toBe(true);
	});

	test("rejects objectives that merely mention ultragoal paths", () => {
		expect(
			isKnownUltragoalObjective("Please inspect .skc/ultragoal/goals.json and .skc/ultragoal/ledger.jsonl for fun"),
		).toBe(false);
	});
});
