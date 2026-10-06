import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { createSubagentSettings } from "../../src/task/executor";

describe("createSubagentSettings service-tier inheritance", () => {
	it("inherits the LIVE parent session tier by default (not the stale settings snapshot)", () => {
		// Runtime `/fast on` lives on the live session tier, not settings: base
		// settings say `none`, but the live inherited tier must win.
		const base = Settings.isolated({ serviceTier: "none" });
		expect(base.get("task.serviceTier")).toBe("inherit");

		const subagent = createSubagentSettings(base, "priority");
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("inherits a scoped live tier (openai-only) when task.serviceTier is inherit", () => {
		const base = Settings.isolated({ "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, "openai-only");
		expect(subagent.get("serviceTier")).toBe("openai-only");
	});

	it("inherits a scoped live tier (claude-only) when task.serviceTier is inherit", () => {
		const base = Settings.isolated({ "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, "claude-only");
		expect(subagent.get("serviceTier")).toBe("claude-only");
	});

	it("maps an undefined inherited tier to none on the inherit branch", () => {
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "inherit" });
		// No live tier passed (e.g. session tier is undefined) → subagent gets none,
		// regardless of the stale settings value.
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("none");
	});

	it("lets an explicit task.serviceTier override win over the inherited live tier", () => {
		const base = Settings.isolated({ serviceTier: "none", "task.serviceTier": "priority" });
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("priority");
	});

	it("can disable the subagent tier with an explicit none while the parent keeps priority", () => {
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "none" });
		const subagent = createSubagentSettings(base, "priority");
		expect(subagent.get("serviceTier")).toBe("none");
		// Main session settings are untouched by the subagent override.
		expect(base.get("serviceTier")).toBe("priority");
	});

	it("inheriting undefined (after /fast off) does not resurrect a startup tier", () => {
		// Regression: the live session tier is the source of truth. A session that
		// started with priority but later ran `/fast off` (live tier undefined) must
		// hand subagents `none`, never the stale startup value.
		const base = Settings.isolated({ serviceTier: "priority", "task.serviceTier": "inherit" });
		const subagent = createSubagentSettings(base, undefined);
		expect(subagent.get("serviceTier")).toBe("none");
	});
});

describe("createSubagentSettings retry-policy provenance", () => {
	it("keeps inherited schema retry budgets implicit through nested children", () => {
		const parent = Settings.isolated({});
		const child = createSubagentSettings(parent);
		const grandchild = createSubagentSettings(child);

		for (const key of ["fallback.maxAttempts", "retry.enabled", "retry.maxRetries", "retry.baseDelayMs"] as const) {
			expect(child.get(key)).toEqual(parent.get(key));
			expect(grandchild.get(key)).toEqual(parent.get(key));
			expect(child.has(key)).toBe(false);
			expect(grandchild.has(key)).toBe(false);
		}
	});

	it("preserves explicit budgets even when they equal schema defaults", () => {
		const parent = Settings.isolated({ "fallback.maxAttempts": 3, "retry.maxRetries": 3 });
		const child = createSubagentSettings(parent);
		const grandchild = createSubagentSettings(child);

		for (const key of ["fallback.maxAttempts", "retry.maxRetries"] as const) {
			expect(child.get(key)).toBe(3);
			expect(grandchild.get(key)).toBe(3);
			expect(child.has(key)).toBe(true);
			expect(grandchild.has(key)).toBe(true);
		}
	});

	it("retains explicit retry opt-outs without making other defaults explicit", () => {
		const parent = Settings.isolated({ "retry.enabled": false, "retry.maxRetries": 0 });
		const child = createSubagentSettings(parent);

		expect(child.get("retry.enabled")).toBe(false);
		expect(child.get("retry.maxRetries")).toBe(0);
		expect(child.has("retry.enabled")).toBe(true);
		expect(child.has("retry.maxRetries")).toBe(true);
		expect(child.has("fallback.maxAttempts")).toBe(false);
		expect(child.get("async.enabled")).toBe(false);
		expect(child.get("bash.autoBackground.enabled")).toBe(false);
		expect(parent.has("async.enabled")).toBe(false);
	});
});
