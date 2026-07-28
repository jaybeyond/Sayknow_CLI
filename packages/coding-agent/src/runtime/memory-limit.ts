export interface EffectiveMemoryLimitInput {
	hardCapBytes?: number | null;
	policyLimitBytes?: number | null;
}

export interface EffectiveMemoryLimit {
	hardCapBytes: number | null;
	policyLimitBytes: number | null;
	effectiveBytes: number | null;
	source: "none" | "hard_cap" | "policy_limit" | "hard_cap_and_policy_limit";
}

function normalizePositiveByteCount(value: number | null | undefined): number | null {
	return Number.isSafeInteger(value) && typeof value === "number" && value > 0 ? value : null;
}

export function resolveEffectiveMemoryLimit(input: EffectiveMemoryLimitInput): EffectiveMemoryLimit {
	const hardCapBytes = normalizePositiveByteCount(input.hardCapBytes);
	const policyLimitBytes = normalizePositiveByteCount(input.policyLimitBytes);
	if (hardCapBytes !== null && policyLimitBytes !== null) {
		return {
			hardCapBytes,
			policyLimitBytes,
			effectiveBytes: Math.min(hardCapBytes, policyLimitBytes),
			source: "hard_cap_and_policy_limit",
		};
	}
	if (hardCapBytes !== null) {
		return {
			hardCapBytes,
			policyLimitBytes: null,
			effectiveBytes: hardCapBytes,
			source: "hard_cap",
		};
	}
	if (policyLimitBytes !== null) {
		return {
			hardCapBytes: null,
			policyLimitBytes,
			effectiveBytes: policyLimitBytes,
			source: "policy_limit",
		};
	}
	return {
		hardCapBytes: null,
		policyLimitBytes: null,
		effectiveBytes: null,
		source: "none",
	};
}
