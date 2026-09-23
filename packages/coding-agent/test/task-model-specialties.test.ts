import { describe, expect, it } from "bun:test";
import { reconcileSettingsSchema } from "@sayknow-cli/coding-agent/config/settings-schema";
import {
	dedupeRoutingCandidates,
	isTaskModelSpecialty,
	specialtiesForRole,
	specialtySelectorHead,
	specialtySelectorIdentity,
	specialtySupportsRole,
	TASK_MODEL_SPECIALTY_IDS,
	type TaskRoutingCandidate,
	toRoutingCandidates,
} from "@sayknow-cli/coding-agent/config/task-model-specialties";
import { taskItemSchema } from "@sayknow-cli/coding-agent/task/types";

describe("task model specialty taxonomy", () => {
	it("exposes exactly the five bounded ids", () => {
		expect(TASK_MODEL_SPECIALTY_IDS).toEqual([
			"backendArchitecture",
			"frontendDesign",
			"implementation",
			"testing",
			"review",
		]);
	});

	it("accepts only declared ids", () => {
		expect(isTaskModelSpecialty("frontendDesign")).toBe(true);
		expect(isTaskModelSpecialty("frontenddesign")).toBe(false);
		expect(isTaskModelSpecialty("none")).toBe(false);
		expect(isTaskModelSpecialty("executor")).toBe(false);
		expect(isTaskModelSpecialty(undefined)).toBe(false);
	});

	it("maps each canonical role to its compatible specialties and nothing else", () => {
		expect(specialtiesForRole("planner")).toEqual(["backendArchitecture", "frontendDesign"]);
		expect(specialtiesForRole("architect")).toEqual(["backendArchitecture", "frontendDesign"]);
		expect(specialtiesForRole("executor")).toEqual(["implementation", "testing"]);
		expect(specialtiesForRole("critic")).toEqual(["review"]);
		// `default` is the main-model assignment target, never a subagent routing role.
		expect(specialtiesForRole("default")).toEqual([]);
		expect(specialtiesForRole("nonexistent-agent")).toEqual([]);
	});

	it("refuses a design specialty on an implementation role", () => {
		expect(specialtySupportsRole("frontendDesign", "planner")).toBe(true);
		expect(specialtySupportsRole("frontendDesign", "executor")).toBe(false);
		expect(specialtySupportsRole("implementation", "planner")).toBe(false);
		expect(specialtySupportsRole("review", "critic")).toBe(true);
		expect(specialtySupportsRole("review", "executor")).toBe(false);
	});
});

describe("routing candidate identity", () => {
	it("keeps an explicit thinking suffix as part of the identity", () => {
		expect(specialtySelectorIdentity("  Anthropic/Claude-Opus-5:High ")).toBe("anthropic/claude-opus-5:high");
		expect(specialtySelectorIdentity("anthropic/claude-opus-5:high")).not.toBe(
			specialtySelectorIdentity("anthropic/claude-opus-5:low"),
		);
	});

	it("exposes the provider/model head separately from the suffix", () => {
		expect(specialtySelectorHead("anthropic/claude-opus-5:high")).toBe("anthropic/claude-opus-5");
		expect(specialtySelectorHead("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
	});

	it("expands a configured chain in order and drops blanks", () => {
		expect(toRoutingCandidates(["a/one", "  ", "b/two:high"], "specialty", { specialty: "testing" })).toEqual([
			{ selector: "a/one", source: "specialty", specialty: "testing" },
			{ selector: "b/two:high", source: "specialty", specialty: "testing" },
		]);
		expect(toRoutingCandidates(undefined, "tier", { tier: "fast" })).toEqual([]);
		expect(toRoutingCandidates("", "baseline")).toEqual([]);
	});
});

describe("candidate composition", () => {
	const specialty: TaskRoutingCandidate[] = [
		{ selector: "design/model:high", source: "specialty", specialty: "frontendDesign" },
	];
	const tier: TaskRoutingCandidate[] = [{ selector: "deep/model", source: "tier", tier: "deep" }];
	const baseline: TaskRoutingCandidate[] = [
		{ selector: "role/model", source: "baseline" },
		{ selector: "role/fallback", source: "baseline" },
	];

	it("preserves specialty then tier then baseline order", () => {
		expect(dedupeRoutingCandidates([specialty, tier, baseline]).map(c => c.selector)).toEqual([
			"design/model:high",
			"deep/model",
			"role/model",
			"role/fallback",
		]);
	});

	it("keeps the first occurrence of a repeated identity", () => {
		const repeated = dedupeRoutingCandidates([specialty, specialty, tier]);
		expect(repeated.map(c => c.selector)).toEqual(["design/model:high", "deep/model"]);
	});

	it("attributes a baseline-overlapping selector to baseline even when a specialty listed it first", () => {
		const overlapping: TaskRoutingCandidate[] = [
			{ selector: "role/model", source: "specialty", specialty: "frontendDesign" },
		];
		const composed = dedupeRoutingCandidates([overlapping, baseline]);

		expect(composed).toEqual([
			{ selector: "role/model", source: "baseline" },
			{ selector: "role/fallback", source: "baseline" },
		]);
	});

	it("does not collapse selectors that differ only by thinking suffix", () => {
		const composed = dedupeRoutingCandidates([
			[{ selector: "role/model:high", source: "specialty", specialty: "testing" }],
			[{ selector: "role/model:low", source: "baseline" }],
		]);

		expect(composed.map(c => `${c.selector}:${c.source}`)).toEqual([
			"role/model:high:specialty",
			"role/model:low:baseline",
		]);
	});
});

describe("task.modelRouting.specialtyModels settings validation", () => {
	function reconcile(value: unknown) {
		return reconcileSettingsSchema({ task: { modelRouting: { specialtyModels: value } } });
	}

	it("defaults to an empty record", () => {
		const { report } = reconcile({});
		expect(report.valid).toBe(true);
		expect(report.issues).toEqual([]);
	});

	it("accepts every declared specialty key, as a selector or a chain", () => {
		const { report } = reconcile({
			backendArchitecture: "a/backend",
			frontendDesign: ["a/design:high", "b/design"],
			implementation: "a/impl",
			testing: "a/test",
			review: "a/review:xhigh",
		});
		expect(report.valid).toBe(true);
		expect(report.issues).toEqual([]);
	});

	it("rejects an unknown or misspelled key instead of silently keeping it", () => {
		const { report } = reconcile({ frontenddesign: "a/design" });
		const issue = report.issues.find(i => i.path === "task.modelRouting.specialtyModels.frontenddesign");

		expect(report.valid).toBe(false);
		expect(issue?.kind).toBe("invalid");
		expect(issue?.detail).toContain("Unknown key");
	});

	it("rejects a legacy-looking key that is not part of the taxonomy", () => {
		const { report } = reconcile({ frontend: "a/design" });
		expect(report.valid).toBe(false);
		expect(report.issues.some(i => i.path === "task.modelRouting.specialtyModels.frontend")).toBe(true);
	});

	it("rejects a malformed value under a valid key", () => {
		const { report } = reconcile({ testing: 42 });
		const issue = report.issues.find(i => i.path === "task.modelRouting.specialtyModels.testing");

		expect(report.valid).toBe(false);
		expect(issue?.detail).toBe("Expected model-selector-value.");
	});
});

describe("task item `specialty`", () => {
	const base = { id: "FrontendBuild", description: "ui", assignment: "Build the settings screen per the spec." };

	it("accepts every bounded id and nothing else", () => {
		for (const specialty of TASK_MODEL_SPECIALTY_IDS) {
			expect(taskItemSchema.safeParse({ ...base, specialty }).success).toBe(true);
		}
		// A free-form label would silently route nowhere; the schema must refuse it
		// so the caller learns the id set instead of shipping an inert spawn.
		expect(taskItemSchema.safeParse({ ...base, specialty: "frontend" }).success).toBe(false);
		expect(taskItemSchema.safeParse({ ...base, specialty: "" }).success).toBe(false);
	});

	it("is optional", () => {
		expect(taskItemSchema.safeParse(base).success).toBe(true);
	});
});
