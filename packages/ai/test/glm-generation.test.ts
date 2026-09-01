import { describe, expect, test } from "bun:test";
import { glmGeneration } from "../src/model-thinking";
import { getBundledModel, getBundledModels } from "../src/models";

describe("glmGeneration", () => {
	test("reads plain and point generations, including suffixed variants", () => {
		expect(glmGeneration("glm-5")).toBe(5);
		expect(glmGeneration("glm-5-turbo")).toBe(5);
		expect(glmGeneration("glm-4.7")).toBe(4.7);
		expect(glmGeneration("glm-4.7-flashx")).toBe(4.7);
		expect(glmGeneration("glm-5.3")).toBe(5.3);
		expect(glmGeneration("glm-5.3-flash")).toBe(5.3);
		expect(glmGeneration("glm-5.3-highspeed")).toBe(5.3);
	});

	test("rejects the vision line, other families, and provider-prefixed ids", () => {
		// The vision line has different limits, so it must not inherit text-model
		// corrections keyed on generation.
		expect(glmGeneration("glm-5v-turbo")).toBeUndefined();
		expect(glmGeneration("gpt-5.3")).toBeUndefined();
		// The zai corrections run on bare provider ids; aggregator-prefixed ids
		// belong to other providers and must not match.
		expect(glmGeneration("z-ai/glm-5.3")).toBeUndefined();
	});
});

describe("zai context window correction", () => {
	test("GLM-5.2 and newer bundle the full 1M window", () => {
		for (const id of ["glm-5.2", "glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed"]) {
			expect(getBundledModel("zai", id).contextWindow).toBe(1_000_000);
		}
	});

	test("older generations keep their smaller published windows", () => {
		// Guards against the correction widening to models that never shipped 1M.
		expect(getBundledModel("zai", "glm-5.1").contextWindow).toBeLessThan(1_000_000);
		expect(getBundledModel("zai", "glm-4.7").contextWindow).toBeLessThan(1_000_000);
	});

	test("the correction never clamps a larger published window down to 1M", () => {
		for (const model of getBundledModels("zai")) {
			const generation = glmGeneration(model.id);
			if (generation === undefined || generation < 5.2) continue;
			expect(model.contextWindow).toBeGreaterThanOrEqual(1_000_000);
		}
	});
});
