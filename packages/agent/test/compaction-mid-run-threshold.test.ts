import { describe, expect, it } from "bun:test";
import {
	DEFAULT_AUTO_THRESHOLD_CEILING_TOKENS,
	DEFAULT_COMPACTION_SETTINGS,
	resolveMidRunThresholdTokens,
	resolveThresholdTokens,
} from "@sayknow-cli/agent-core/compaction/compaction";

const defaults = { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false };

describe("mid-run compaction threshold", () => {
	it("defers a lowered threshold to answer boundaries on a window with room past the ceiling", () => {
		const settings = { ...defaults, thresholdTokens: 150_000 };
		expect(resolveThresholdTokens(1_000_000, settings)).toBe(150_000);
		expect(resolveMidRunThresholdTokens(1_000_000, settings)).toBe(DEFAULT_AUTO_THRESHOLD_CEILING_TOKENS);
	});

	it("keeps a configured threshold above the ceiling in force mid-run", () => {
		const settings = { ...defaults, thresholdTokens: 500_000 };
		expect(resolveMidRunThresholdTokens(1_000_000, settings)).toBe(500_000);
	});

	it("matches the boundary threshold when nothing is configured", () => {
		expect(resolveMidRunThresholdTokens(1_000_000, defaults)).toBe(resolveThresholdTokens(1_000_000, defaults));
	});

	it("keeps the configured threshold on windows without room past the ceiling", () => {
		// 200K window: the reserve-based limit (170K) is below the ceiling, so deferring
		// would push the run toward the provider limit.
		const settings = { ...defaults, thresholdTokens: 100_000 };
		expect(resolveMidRunThresholdTokens(200_000, settings)).toBe(100_000);
	});
});
