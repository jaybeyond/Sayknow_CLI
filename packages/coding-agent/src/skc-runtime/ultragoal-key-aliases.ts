import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;

// Translate only named slots. Receipt hashes are over the raw gate appended to
// the ledger, never over the normalized read view.
const gateKeys = {
	architectReview: "review",
	executorQa: "verify",
	iteration: "rerun",
	criticReview: "signoff",
	deferredToBatch: "batchDeferred",
	validationBatchClose: "batchClose",
};
const verifyKeys = { redTeamStatus: "attackStatus", redTeamCommands: "attackCommands" };
const deferredKeys = { aiSlopCleaner: "cleanup", iteration: "rerun" };
const lanes = { architectReview: "review", executorQa: "verify" };
const deferredKinds = { "validation-batch-deferred": "batch-deferred" };
const closeKinds = { "validation-batch-close": "batch-close" };
const sources = { "validation-batch": "batch" };

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function aliases(table: Record<string, string>, reverse: boolean): [string, string][] {
	return Object.entries(table).map(([old, name]) => (reverse ? [name, old] : [old, name]));
}

function translateKeys(
	value: JsonObject,
	table: Record<string, string>,
	prefix: string,
	legacy: string[],
	reverse: boolean,
): void {
	for (const [from, to] of aliases(table, reverse)) {
		if (!Object.hasOwn(value, from)) continue;
		if (Object.hasOwn(value, to)) {
			throw new Error(`qualityGate has both ${prefix}${from} and ${prefix}${to}; use ${prefix}${to} only`);
		}
		value[to] = value[from];
		delete value[from];
		legacy.push(`${prefix}${from}->${prefix}${to}`);
	}
}

function translateValue(
	value: unknown,
	table: Record<string, string>,
	slot: string,
	legacy: string[],
	reverse: boolean,
): unknown {
	for (const [from, to] of aliases(table, reverse)) {
		if (value === from) {
			legacy.push(`${slot}:${from}->${to}`);
			return to;
		}
	}
	return value;
}

function translateGate(raw: JsonObject, reverse: boolean): { gate: JsonObject; legacyKeys: string[] } {
	const gate = structuredClone(raw);
	const legacyKeys: string[] = [];
	if (!reverse) translateKeys(gate, gateKeys, "", legacyKeys, reverse);
	const verify = object(gate.verify);
	if (verify) translateKeys(verify, verifyKeys, "verify.", legacyKeys, reverse);
	const deferred = object(gate.batchDeferred);
	if (deferred) {
		translateKeys(deferred, deferredKeys, "batchDeferred.", legacyKeys, reverse);
		if (Object.hasOwn(deferred, "kind")) {
			deferred.kind = translateValue(deferred.kind, deferredKinds, "batchDeferred.kind", legacyKeys, reverse);
		}
		if (Array.isArray(deferred.deferredLanes)) {
			const laneValues: unknown[] = deferred.deferredLanes.map((lane: unknown) =>
				typeof lane === "string" ? lane.trim() : lane,
			);
			const mapped = deferred.deferredLanes.map((lane: unknown, index: number) => {
				const trimmed = laneValues[index];
				const translated = translateValue(trimmed, lanes, "batchDeferred.deferredLanes", legacyKeys, reverse);
				return typeof lane === "string" &&
					typeof trimmed === "string" &&
					typeof translated === "string" &&
					translated !== trimmed
					? lane.replace(trimmed, () => translated)
					: lane;
			});
			if (!reverse) {
				for (const [old, name] of Object.entries(lanes)) {
					if (laneValues.includes(old) && laneValues.includes(name)) {
						throw new Error(
							`qualityGate batchDeferred.deferredLanes has both ${old} and ${name}; use ${name} only`,
						);
					}
				}
			}
			deferred.deferredLanes = mapped;
		}
	}
	const close = object(gate.batchClose);
	if (close) {
		if (Object.hasOwn(close, "kind")) {
			close.kind = translateValue(close.kind, closeKinds, "batchClose.kind", legacyKeys, reverse);
		}
		const union = object(close.unionChangeSet);
		if (union && Object.hasOwn(union, "source")) {
			union.source = translateValue(union.source, sources, "batchClose.unionChangeSet.source", legacyKeys, reverse);
		}
	}
	if (reverse) translateKeys(gate, gateKeys, "", legacyKeys, reverse);
	return { gate, legacyKeys };
}

export function normalizeQualityGateInput(raw: JsonObject): { gate: JsonObject; legacyKeys: string[] } {
	return translateGate(raw, false);
}

export function toStorageGate(canonical: JsonObject): JsonObject {
	return translateGate(canonical, true).gate;
}

export function readQualityGateView(raw: unknown): JsonObject | null {
	const record = object(raw);
	if (!record) return null;
	try {
		return normalizeQualityGateInput(record).gate;
	} catch {
		return null;
	}
}

export function readSignoff(raw: unknown): JsonObject | undefined {
	return object(readQualityGateView(raw)?.signoff);
}

export function readBatchClose(raw: unknown): JsonObject | undefined {
	return object(readQualityGateView(raw)?.batchClose);
}

export function readBatchDeferred(raw: unknown): JsonObject | undefined {
	return object(readQualityGateView(raw)?.batchDeferred);
}

export function normalizeVerifyInput(raw: JsonObject): { verify: JsonObject; legacyKeys: string[] } {
	const verify = structuredClone(raw);
	const legacyKeys: string[] = [];
	translateKeys(verify, verifyKeys, "verify.", legacyKeys, false);
	return { verify, legacyKeys };
}

export function normalizeReviewFindingKey(message: string): string {
	return message
		.trim()
		.replace(
			/^((?:(?:[A-Z_]+: )?qualityGate )?)executorQa\.(?=(?:artifactRefs|surfaceEvidence|contractCoverage|adversarialCases|blockers)\b)/,
			"$1verify.",
		);
}

export function resolveStoredBatch(record: JsonObject, label: string): unknown {
	if (
		Object.hasOwn(record, "validationBatch") &&
		Object.hasOwn(record, "batch") &&
		!isDeepStrictEqual(record.validationBatch, record.batch)
	) {
		throw new Error(`Invalid ultragoal plan: ${label} has both validationBatch and batch`);
	}
	return record.validationBatch ?? record.batch;
}

export function isBatchDependencyGroupKind(kind: unknown): boolean {
	return kind === "validation-batch" || kind === "batch";
}
