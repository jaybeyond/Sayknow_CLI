import { describe, expect, test } from "bun:test";
import {
	normalizeQualityGateInput,
	normalizeReviewFindingKey,
	readQualityGateView,
	resolveStoredBatch,
	toStorageGate,
} from "../../src/skc-runtime/ultragoal-key-aliases";

const legacy = {
	architectReview: { evidence: "executorQa stays literal in evidence" },
	executorQa: { redTeamCommands: ["skc ultragoal status"], redTeamStatus: "passed" },
	iteration: { fullRerun: true },
	criticReview: { verdict: "OKAY" },
	deferredToBatch: {
		kind: "validation-batch-deferred",
		deferredLanes: ["architectReview", "executorQa"],
		aiSlopCleaner: { status: "passed" },
		iteration: { fullRerun: true },
	},
	validationBatchClose: { kind: "validation-batch-close", unionChangeSet: { source: "validation-batch" } },
};

describe("ultragoal quality gate aliases", () => {
	test("translates only named slots and round-trips to the exact legacy data", () => {
		const before = structuredClone(legacy);
		const { gate, legacyKeys } = normalizeQualityGateInput(legacy);
		expect(gate).toEqual({
			review: legacy.architectReview,
			verify: { attackCommands: ["skc ultragoal status"], attackStatus: "passed" },
			rerun: legacy.iteration,
			signoff: legacy.criticReview,
			batchDeferred: {
				kind: "batch-deferred",
				deferredLanes: ["review", "verify"],
				cleanup: { status: "passed" },
				rerun: { fullRerun: true },
			},
			batchClose: { kind: "batch-close", unionChangeSet: { source: "batch" } },
		});
		expect(legacyKeys).toContain("verify.redTeamStatus->verify.attackStatus");
		expect(toStorageGate(gate)).toEqual(legacy);
		expect(legacy).toEqual(before);
	});

	test("rejects duplicate spellings, including deferred lane values", () => {
		const conflicts = [
			{ review: {}, architectReview: {} },
			{ verify: { attackStatus: "passed", redTeamStatus: "passed" } },
			{ batchDeferred: { deferredLanes: ["review", "architectReview"] } },
		];
		for (const gate of conflicts) {
			expect(() => normalizeQualityGateInput(gate)).toThrow("has both");
			expect(readQualityGateView(gate)).toBeNull();
		}
	});

	test("round-trips padded legacy lanes without changing their stored spelling", () => {
		const input = { deferredToBatch: { deferredLanes: [" architectReview ", "\texecutorQa"] } };
		const { gate } = normalizeQualityGateInput(input);
		expect(gate.batchDeferred).toEqual({ deferredLanes: [" review ", "\tverify"] });
		expect(toStorageGate(gate)).toEqual(input);
	});

	test("normalizes diagnostic labels without rewriting blocker text", () => {
		expect(normalizeReviewFindingKey("executorQa.blockers: Review executorQa output")).toBe(
			"verify.blockers: Review executorQa output",
		);
		expect(normalizeReviewFindingKey("verify.blockers: Review executorQa output")).not.toBe(
			normalizeReviewFindingKey("verify.blockers: Review verify output"),
		);
	});
	test("accepts either disk batch key without accepting contradictory metadata", () => {
		const metadata = { finalGoalId: "G002", memberIds: ["G001", "G002"] };
		expect(resolveStoredBatch({ batch: metadata }, "G001")).toEqual(metadata);
		expect(resolveStoredBatch({ validationBatch: metadata, batch: { ...metadata } }, "G001")).toEqual(metadata);
		expect(() => resolveStoredBatch({ validationBatch: metadata, batch: {} }, "Goal G001")).toThrow(
			"Goal G001 has both validationBatch and batch",
		);
	});
});
