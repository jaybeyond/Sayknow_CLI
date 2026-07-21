import { describe, expect, it } from "bun:test";
import { requirePipelineStartable } from "@sayknow-cli/coding-agent/skc-runtime/ultragoal-pipeline";

describe("ultragoal pipeline extraction", () => {
	it("preserves aggregate-only overlap enforcement", () => {
		const goal = { id: "G001", status: "active" } as never;
		expect(() => requirePipelineStartable({ skcGoalMode: "per-story", goals: [] } as never, goal, goal)).toThrow(
			"pipeline overlap is supported only for aggregate ultragoal mode",
		);
	});
});
