import { describe, expect, test } from "bun:test";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "@sayknow-cli/agent-core/compaction/compaction";
import type { SessionEntry, SessionMessageEntry } from "@sayknow-cli/agent-core/compaction/entries";
import {
	estimateToolOutputPruneSavings,
	type PruneConfig,
	pruneToolOutputs,
	shouldPruneAtThreshold,
	shouldRunMaintenancePrune,
} from "@sayknow-cli/agent-core/compaction/pruning";
import type { ToolResultMessage } from "@sayknow-cli/ai/types";

const timestamp = "2026-06-12T00:00:00.000Z";

function toolEntry(id: string, text: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.parse(timestamp),
		} as ToolResultMessage,
	};
}

function bigText(label: string, lines: number): string {
	return Array.from({ length: lines }, (_, i) => `${label}-${i} ${"x".repeat(60)}`).join("\n");
}

function clone(entries: SessionEntry[]): SessionEntry[] {
	return structuredClone(entries);
}

const config: PruneConfig = {
	protectTokens: 50,
	minimumSavings: 50,
	protectedTools: ["skill", "read"],
	staleOverridableTools: ["read"],
};

function textOf(entry: SessionEntry): string {
	const msg = (entry as SessionMessageEntry).message as ToolResultMessage;
	return msg.content.map(c => (c.type === "text" ? c.text : "")).join("");
}

describe("estimateToolOutputPruneSavings (Finding 13)", () => {
	test("estimates the same savings pruneToolOutputs would achieve, without mutating", () => {
		const entries = [
			toolEntry("old1", bigText("old1", 200)),
			toolEntry("old2", bigText("old2", 200)),
			toolEntry("recent", bigText("recent", 1)),
		];
		const before = textOf(entries[0]!);

		const estimate = estimateToolOutputPruneSavings(entries, config);

		// Non-mutating: original content is intact after estimation.
		expect(textOf(entries[0]!)).toBe(before);
		expect(estimate.tokensSaved).toBeGreaterThan(0);
		expect(estimate.prunableCount).toBeGreaterThan(0);

		// Matches the real (mutating) prune's savings on an identical clone.
		const real = pruneToolOutputs(clone(entries), config);
		expect(estimate.tokensSaved).toBe(real.tokensSaved);
		expect(estimate.prunableCount).toBe(real.prunedCount);
	});

	test("returns zero when total savings are below the configured minimum", () => {
		const entries = [toolEntry("a", bigText("a", 200)), toolEntry("b", bigText("b", 200))];
		const highMin: PruneConfig = { ...config, minimumSavings: 10_000_000 };
		const estimate = estimateToolOutputPruneSavings(entries, highMin);
		expect(estimate.tokensSaved).toBe(0);
		expect(estimate.prunableCount).toBe(0);
	});

	test("uses an explicit relaxed minimum for threshold compaction only", () => {
		const entries = [toolEntry("old1", bigText("old1", 200)), toolEntry("old2", bigText("old2", 200))];
		const highMin: PruneConfig = { ...config, minimumSavings: 10_000_000 };

		expect(estimateToolOutputPruneSavings(entries, highMin).tokensSaved).toBe(0);
		const relaxed = estimateToolOutputPruneSavings(entries, highMin, { relaxedMinimum: 0 });
		expect(relaxed.tokensSaved).toBeGreaterThan(0);
		expect(pruneToolOutputs(entries, highMin, { relaxedMinimum: 0 }).tokensSaved).toBe(relaxed.tokensSaved);
	});
});

describe("shouldRunMaintenancePrune (Finding 13)", () => {
	const base = { enabled: true, estimatedSavings: 30_000, minSavings: 8_000, cacheEpochResetCost: 5_000 };

	test("runs when opted in, savings clear the minimum, and savings beat the cache-epoch reset cost", () => {
		expect(shouldRunMaintenancePrune(base)).toBe(true);
	});

	test("blocked when disabled (default-off)", () => {
		expect(shouldRunMaintenancePrune({ ...base, enabled: false })).toBe(false);
	});

	test("does not run below the savings threshold", () => {
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 7_999 })).toBe(false);
	});

	test("does not run when savings do not exceed the cache-epoch reset cost", () => {
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 30_000, cacheEpochResetCost: 30_000 })).toBe(false);
		expect(shouldRunMaintenancePrune({ ...base, estimatedSavings: 30_000, cacheEpochResetCost: 40_000 })).toBe(false);
	});

	test("no cache means no reset cost, so a large reclaim runs", () => {
		expect(shouldRunMaintenancePrune({ ...base, cacheEpochResetCost: 0 })).toBe(true);
	});
});

describe("shouldPruneAtThreshold", () => {
	// A million-token window with default settings compacts at the 300k ceiling,
	// so a prune must bring the context to 240k or less (20% of the threshold free).
	const window = 1_000_000;
	const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };

	test("skips a prune that only just gets back under the threshold", () => {
		expect(shouldPruneAtThreshold(300_001, 18_000, window, settings)).toBe(false);
		expect(shouldPruneAtThreshold(300_001, 60_000, window, settings)).toBe(false);
	});

	test("runs a prune that leaves the minimum headroom, inclusive at the boundary", () => {
		expect(shouldPruneAtThreshold(300_001, 60_001, window, settings)).toBe(true);
		expect(shouldPruneAtThreshold(360_000, 120_000, window, settings)).toBe(true);
		expect(shouldPruneAtThreshold(360_000, 119_999, window, settings)).toBe(false);
	});

	test("never runs without savings", () => {
		expect(shouldPruneAtThreshold(100_000, 0, window, settings)).toBe(false);
	});

	test("measures headroom against a configured threshold", () => {
		const fixed: CompactionSettings = { ...settings, thresholdTokens: 100_000 };
		expect(shouldPruneAtThreshold(115_000, 35_000, window, fixed)).toBe(true);
		expect(shouldPruneAtThreshold(115_000, 30_000, window, fixed)).toBe(false);
	});

	test("pruneMinHeadroomPercent 0 accepts any prune that gets back under the threshold", () => {
		const noHeadroom: CompactionSettings = { ...settings, pruneMinHeadroomPercent: 0 };
		expect(shouldPruneAtThreshold(300_001, 1, window, noHeadroom)).toBe(true);
		expect(shouldPruneAtThreshold(300_002, 1, window, noHeadroom)).toBe(false);
	});

	test("a larger pruneMinHeadroomPercent demands more headroom", () => {
		const half: CompactionSettings = { ...settings, pruneMinHeadroomPercent: 50 };
		expect(shouldPruneAtThreshold(300_001, 150_001, window, half)).toBe(true);
		expect(shouldPruneAtThreshold(300_001, 150_000, window, half)).toBe(false);
	});
});
