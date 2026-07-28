import { describe, expect, it } from "bun:test";
import { resolveEffectiveMemoryLimit } from "../../src/runtime/memory-limit";

describe("resolveEffectiveMemoryLimit", () => {
	it("caps the manual policy limit at the authoritative hard cap", () => {
		expect(resolveEffectiveMemoryLimit({ hardCapBytes: 100, policyLimitBytes: 120 })).toEqual({
			hardCapBytes: 100,
			policyLimitBytes: 120,
			effectiveBytes: 100,
			source: "hard_cap_and_policy_limit",
		});
	});

	it("accepts a policy limit when no hard cap is available", () => {
		expect(resolveEffectiveMemoryLimit({ policyLimitBytes: 256 })).toEqual({
			hardCapBytes: null,
			policyLimitBytes: 256,
			effectiveBytes: 256,
			source: "policy_limit",
		});
	});

	it("drops invalid limits instead of fabricating an effective cap", () => {
		expect(resolveEffectiveMemoryLimit({ hardCapBytes: 0, policyLimitBytes: Number.NaN })).toEqual({
			hardCapBytes: null,
			policyLimitBytes: null,
			effectiveBytes: null,
			source: "none",
		});
	});
});
