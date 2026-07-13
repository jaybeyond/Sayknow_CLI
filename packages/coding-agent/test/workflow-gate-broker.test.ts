import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcWorkflowGate } from "@sayknow-cli/coding-agent/modes/rpc/rpc-types";
import {
	FileGateStore,
	type GateAuditEvent,
	MemoryGateStore,
	WorkflowGateBroker,
	WorkflowGateBrokerError,
} from "@sayknow-cli/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

function makeBroker(
	extra: { audit?: (e: GateAuditEvent) => void; advance?: (g: RpcWorkflowGate, a: unknown) => void } = {},
) {
	const emitted: RpcWorkflowGate[] = [];
	const audit: GateAuditEvent[] = [];
	const advanced: Array<{ gate: RpcWorkflowGate; answer: unknown }> = [];
	const broker = new WorkflowGateBroker("2026-06-05-0449-4845", new MemoryGateStore(), {
		emit: g => emitted.push(g),
		advance: (g, a) => {
			advanced.push({ gate: g, answer: a });
			extra.advance?.(g, a);
		},
		audit: e => {
			audit.push(e);
			extra.audit?.(e);
		},
	});
	return { broker, emitted, audit, advanced };
}

describe("WorkflowGateBroker", () => {
	it("emits run-scoped monotonic gate ids per stage", () => {
		const { broker, emitted } = makeBroker();
		const g1 = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } });
		const g2 = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["a", "b"] } });
		expect(g1.gate_id).toBe("wg_04494845_ralplan_000001");
		expect(g2.gate_id).toBe("wg_04494845_ralplan_000002");
		expect(emitted).toHaveLength(2);
		expect(g1.schema_hash).toBeTruthy();
		expect(g1.required).toBe(true);
	});

	it("rejects reserved/unknown stages", () => {
		const { broker } = makeBroker();
		expect(() => broker.openGate({ stage: "team" as never, kind: "question", schema: { type: "string" } })).toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("accepts a valid answer, persists before advancing exactly once", async () => {
		const { broker, advanced, audit } = makeBroker();
		const gate = broker.openGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(res.status).toBe("accepted");
		expect(advanced).toHaveLength(1);
		expect(audit.some(e => e.event === "gate_response_accepted")).toBe(true);
	});

	it("preserves acknowledgement policy updates made before advance", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-ack-policy-"));
		const file = path.join(dir, "gates.json");
		const store = new FileGateStore(file);
		let broker: WorkflowGateBroker;
		broker = new WorkflowGateBroker("run-ack-policy", store, {
			finalizeAccepted: async record => {
				if (record.ackPolicy?.kind !== "telegram_selected_v1") throw new Error("missing Telegram policy");
				broker.updateAckPolicy(record.gate.gate_id, {
					...record.ackPolicy,
					state: "delivered",
					outcome: { status: "delivered", messageId: 42 },
					updatedAt: "terminal",
				});
			},
		});
		const gate = broker.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		await broker.resolve(
			{ gate_id: gate.gate_id, answer: "yes" },
			{
				semanticDisposition: "commit",
				resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
				ackPolicy: {
					kind: "telegram_selected_v1",
					commitKey: "commit-1",
					actionId: "interaction-1",
					state: "pending",
					updatedAt: "pending",
				},
			},
		);
		expect(store.get(gate.gate_id)).toMatchObject({
			advanced: true,
			ackPolicy: {
				kind: "telegram_selected_v1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
		const reopened = new FileGateStore(file).get(gate.gate_id);
		expect(reopened).toMatchObject({
			status: "accepted",
			advanced: true,
			answer: "yes",
			semanticDisposition: "commit",
			resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
			resolution: { gate_id: gate.gate_id, status: "accepted" },
			ackPolicy: {
				kind: "telegram_selected_v1",
				commitKey: "commit-1",
				actionId: "interaction-1",
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
	});

	it("leaves the gate pending on an invalid answer", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate({
			stage: "ralplan",
			kind: "approval",
			schema: { type: "string", enum: ["approve"] },
		});
		const res = await broker.resolve({ gate_id: gate.gate_id, answer: "nope" });
		expect(res.status).toBe("rejected");
		expect(res.error?.code).toBe("invalid_workflow_gate_answer");
		expect(advanced).toHaveLength(0);
		// Gate still pending → a subsequent valid answer is accepted.
		const ok = await broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		expect(ok.status).toBe("accepted");
	});

	it("is idempotent on replay and detects conflicts", async () => {
		const { broker, advanced } = makeBroker();
		const gate = broker.openGate({ stage: "ultragoal", kind: "execution", schema: { type: "boolean" } });
		const first = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		const replay = await broker.resolve({ gate_id: gate.gate_id, answer: true, idempotency_key: "k1" });
		expect(replay).toEqual(first);
		expect(advanced).toHaveLength(1); // exactly once
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: false, idempotency_key: "k1" })).rejects.toThrow(
			/idempotency_conflict|conflict/,
		);
		await expect(broker.resolve({ gate_id: gate.gate_id, answer: true })).rejects.toThrow(
			/already_resolved|resolved/,
		);
	});

	it("throws on unknown gate ids", async () => {
		const { broker } = makeBroker();
		await expect(broker.resolve({ gate_id: "wg_x_ralplan_000099", answer: 1 })).rejects.toThrow(
			WorkflowGateBrokerError,
		);
	});

	it("persists durably across broker instances with FileGateStore", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-store-"));
		const file = path.join(dir, "gates.json");
		const b1 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		const gate = b1.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		// New broker instance, same backing file → sees the pending gate.
		const b2 = new WorkflowGateBroker("run-xyz", new FileGateStore(file));
		const res = await b2.resolve({ gate_id: gate.gate_id, answer: "an answer" });
		expect(res.status).toBe("accepted");
	});

	it("serializes live resolution with recovery so advance runs after finalization exactly once", async () => {
		const store = new MemoryGateStore();
		const finalizationStarted = Promise.withResolvers<void>();
		const releaseFinalization = Promise.withResolvers<void>();
		let advances = 0;
		const broker = new WorkflowGateBroker("run-concurrent-recovery", store, {
			finalizeAccepted: async () => {
				finalizationStarted.resolve();
				await releaseFinalization.promise;
			},
			advance: () => {
				advances++;
			},
		});
		const gate = broker.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string" } });
		const resolving = broker.resolve({ gate_id: gate.gate_id, answer: "approve" });
		await finalizationStarted.promise;
		const recovering = broker.recover();
		await Promise.resolve();
		expect(advances).toBe(0);
		releaseFinalization.resolve();
		await expect(resolving).resolves.toMatchObject({ status: "accepted" });
		await expect(recovering).resolves.toEqual([]);
		expect(advances).toBe(1);
	});

	it("recover() advances accepted-but-not-advanced gates exactly once", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-recover-"));
		const file = path.join(dir, "gates.json");
		// First broker: advance throws AFTER the durable accept write, simulating a
		// crash between accept and the advanced:true commit.
		const store1 = new FileGateStore(file);
		const b1 = new WorkflowGateBroker("run-rec", store1, {
			advance: () => {
				throw new Error("simulated crash during advance");
			},
		});
		const gate = b1.openGate({ stage: "ralplan", kind: "approval", schema: { type: "string", enum: ["go"] } });
		await expect(b1.resolve({ gate_id: gate.gate_id, answer: "go" })).rejects.toThrow(/crash/);

		// Fresh broker over the same file recovers exactly once.
		let advances = 0;
		const b2 = new WorkflowGateBroker("run-rec", new FileGateStore(file), {
			advance: () => {
				advances += 1;
			},
		});
		const recovered = await b2.recover();
		expect(recovered).toEqual([gate.gate_id]);
		expect(advances).toBe(1);
		// A second recover() is a no-op (already advanced).
		expect(await b2.recover()).toEqual([]);
		expect(advances).toBe(1);
	});

	it("fails closed on a corrupt FileGateStore instead of silently resetting", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "gate-corrupt-"));
		const file = path.join(dir, "gates.json");
		writeFileSync(file, "{ not valid json");
		expect(() => new FileGateStore(file)).toThrow(/corrupt gate store/);
	});
});
