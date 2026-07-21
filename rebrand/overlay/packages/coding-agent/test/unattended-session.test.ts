import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RpcUnattendedDeclaration, RpcWorkflowGate } from "@sayknow-cli/coding-agent/modes/rpc/rpc-types";
import { approvalGate } from "@sayknow-cli/coding-agent/modes/shared/agent-wire/approval-gate";
import { questionToGate } from "@sayknow-cli/coding-agent/modes/shared/agent-wire/deep-interview-gate";
import {
	modelSupportsTokenCostMetrics,
	UnattendedSessionControlPlane,
} from "@sayknow-cli/coding-agent/modes/shared/agent-wire/unattended-session";
import {
	FileGateStore,
	WorkflowGateBroker,
} from "@sayknow-cli/coding-agent/modes/shared/agent-wire/workflow-gate-broker";

const DECL: RpcUnattendedDeclaration = {
	actor: "hermes",
	budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 10_000, max_cost_usd: 5 },
	scopes: ["prompt"],
	action_allowlist: ["command.prompt"],
};

function makePlane() {
	const emitted: RpcWorkflowGate[] = [];
	const plane = new UnattendedSessionControlPlane({
		runId: "run-1",
		emitFrame: g => emitted.push(g),
		providerSupportsTokenCostMetrics: true,
	});
	return { plane, emitted };
}

describe("UnattendedSessionControlPlane", () => {
	it("is attended (no emitter) until unattended is negotiated", () => {
		const { plane } = makePlane();
		expect(plane.isUnattended()).toBe(false);
		expect(plane.emitGate(approvalGate())).rejects.toThrow(/before unattended mode is negotiated/);
	});

	it("negotiates fail-closed and refuses providers without token/cost metrics", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "r",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: false,
		});
		expect(() => plane.negotiate(DECL)).toThrow();
		expect(plane.isUnattended()).toBe(false);
	});

	it("negotiates fail-closed when the token/cost capability is omitted (#606: no implicit true default)", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "r-omitted",
			emitFrame: g => emitted.push(g),
			// providerSupportsTokenCostMetrics intentionally omitted (undefined).
		});
		expect(() => plane.negotiate(DECL)).toThrow();
		expect(plane.isUnattended()).toBe(false);
	});

	it("bridges emitGate to the RPC answer: the gate frame is emitted and the answer resolves the promise", async () => {
		const { plane, emitted } = makePlane();
		const accepted = plane.negotiate(DECL);
		expect(accepted.actor).toBe("hermes");
		expect(plane.isUnattended()).toBe(true);

		// A runtime emits a gate; the frame is sent to the transport and emitGate awaits.
		const pending = plane.emitGate(approvalGate({ summary: "PRD" }));
		expect(emitted).toHaveLength(1);
		const gate = emitted[0];
		expect(gate.kind).toBe("approval");

		// The external agent answers over RPC; resolveGate completes the emitGate promise.
		const resolution = await plane.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } });
		expect(resolution.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ decision: "approve" });
	});

	it("resolves a synchronously answered emitted gate without losing the answer", async () => {
		let plane: UnattendedSessionControlPlane;
		const emitted: RpcWorkflowGate[] = [];
		plane = new UnattendedSessionControlPlane({
			runId: "run-sync",
			providerSupportsTokenCostMetrics: true,
			emitFrame: gate => {
				emitted.push(gate);
				void plane.resolveGate({ gate_id: gate.gate_id, answer: { decision: "approve" } });
			},
		});
		plane.negotiate(DECL);

		await expect(plane.emitGate(approvalGate({ summary: "sync?" }))).resolves.toEqual({ decision: "approve" });
		expect(emitted).toHaveLength(1);
	});

	it("bridges a deep-interview question gate end-to-end", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
		const gate = emitted[0];
		const resolution = await plane.resolveGate({
			gate_id: gate.gate_id,
			answer: { selected: ["JWT"], other: false },
		});
		expect(resolution.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ selected: ["JWT"], other: false });
	});

	it("rejects a schema-invalid answer and keeps the gate pending (emitGate stays unresolved)", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		let resolved = false;
		const pending = plane.emitGate(approvalGate());
		void pending.then(() => {
			resolved = true;
		});
		const bad = await plane.resolveGate({ gate_id: emitted[0].gate_id, answer: { decision: "maybe" } });
		expect(bad.status).toBe("rejected");
		await Promise.resolve();
		expect(resolved).toBe(false);
		// A valid answer then resolves it.
		const good = await plane.resolveGate({ gate_id: emitted[0].gate_id, answer: { decision: "approve" } });
		expect(good.status).toBe("accepted");
		await expect(pending).resolves.toEqual({ decision: "approve" });
	});

	it("rejects a pending emitGate when the unattended run aborts (no forever-hang)", async () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "run-abort",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: true,
		});
		plane.negotiate({
			...DECL,
			budget: { max_tokens: 1000, max_tool_calls: 1, max_wall_time_ms: 10_000, max_cost_usd: 5 },
		});
		const pending = plane.emitGate(approvalGate());
		let rejected = false;
		void pending.catch(() => {
			rejected = true;
		});
		const controller = plane.controller;
		expect(controller).toBeDefined();
		controller?.preflightToolCall();
		expect(() => controller?.preflightToolCall()).toThrow();
		await controller?.abortCompletion;
		await Promise.resolve();
		expect(rejected).toBe(true);
		await expect(pending).rejects.toThrow(/aborted/);
	});
	it("does not charge max_tool_calls for read-only/control commands; bash still charges (issue 04)", () => {
		const emitted: RpcWorkflowGate[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "budget-run",
			emitFrame: g => emitted.push(g),
			providerSupportsTokenCostMetrics: true,
		});
		plane.negotiate({
			actor: "hermes",
			budget: { max_tokens: 1000, max_tool_calls: 10, max_wall_time_ms: 60_000, max_cost_usd: 5 },
			scopes: ["prompt", "control", "message:read", "bash"],
			action_allowlist: [
				"command.prompt",
				"command.control",
				"command.message_read",
				"command.bash",
				"bash.readonly",
			],
		});
		const controller = plane.controller;
		expect(controller).toBeDefined();
		// Read-only/control/cancellation commands must never consume the tool-call budget.
		for (let i = 0; i < 20; i++) {
			plane.preflightCommand({ type: "get_state" });
			plane.preflightCommand({ type: "set_steering_mode", mode: "all" });
			plane.preflightCommand({ type: "abort" });
		}
		expect(controller?.usageSnapshot().toolCalls).toBe(0);
		// A bash command performs real tool work and still charges one unit.
		plane.preflightCommand({ type: "bash", command: "pwd" });
		expect(controller?.usageSnapshot().toolCalls).toBe(1);
	});

	it("acknowledges a trusted notification commit before claim resolution and workflow advance", async () => {
		const emitted: RpcWorkflowGate[] = [];
		const order: string[] = [];
		const plane = new UnattendedSessionControlPlane({
			runId: "run-notification-commit",
			sessionId: "session-1",
			emitFrame: gate => emitted.push(gate),
			providerSupportsTokenCostMetrics: true,
		});
		plane.negotiate(DECL);
		plane.registerGateTerminalController({
			completeGateInteractions: () => {
				order.push("complete");
			},
			cancelGateInteractions: () => {
				order.push("cancel");
			},
		});
		const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
		const gate = emitted[0]!;
		const resolution = await plane.resolveGateFromNotification(
			{ gate_id: gate.gate_id, answer: { selected: ["JWT"] }, idempotency_key: "answer-1" },
			{
				interactionActionId: "interaction-1",
				replyReceiptId: "receipt-1",
				answerJson: "0",
				idempotencyKey: "answer-1",
				requestSelectedAck: async input => {
					order.push("ack");
					expect(input).toMatchObject({ actionId: "interaction-1", replyReceiptId: "receipt-1" });
					return { status: "delivered", messageId: 42 };
				},
				resolveClaim: () => order.push("resolve-claim"),
				closeClaimInvalid: () => order.push("close-invalid"),
			},
		);
		expect(resolution.status).toBe("accepted");
		expect(order).toEqual(["ack", "resolve-claim", "complete"]);
		await expect(pending).resolves.toEqual({ selected: ["JWT"] });
	});

	it("recovers a persisted pending acknowledgement when the participant registered before negotiation", async () => {
		const file = path.join(mkdtempSync(path.join(tmpdir(), "gate-recovery-pending-")), "gates.json");
		const initialStore = new FileGateStore(file);
		const initialBroker = new WorkflowGateBroker("run-recovery", initialStore, {
			advance: () => {
				throw new Error("simulated crash before advance");
			},
		});
		const gate = initialBroker.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		await expect(
			initialBroker.resolve(
				{ gate_id: gate.gate_id, answer: "yes", idempotency_key: "answer-1" },
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
			),
		).rejects.toThrow("simulated crash");

		let recoveryCalls = 0;
		const plane = new UnattendedSessionControlPlane({
			runId: "run-recovery",
			sessionId: "session-1",
			store: new FileGateStore(file),
			emitFrame: () => {},
			providerSupportsTokenCostMetrics: true,
		});
		plane.setAckRecoveryParticipant({
			requestRecoveredAskSelectedAck: async input => {
				recoveryCalls++;
				expect(input).toMatchObject({ actionId: "interaction-1", commitKey: "commit-1", sessionId: "session-1" });
				return { status: "delivered", messageId: 42 };
			},
		});
		plane.negotiate(DECL);
		await plane.startRecoveryOnce({ participantGraceMs: 0 });

		expect(recoveryCalls).toBe(1);
		expect(new FileGateStore(file).get(gate.gate_id)).toMatchObject({
			advanced: true,
			ackPolicy: {
				state: "delivered",
				outcome: { status: "delivered", messageId: 42 },
			},
		});
	});

	it("does not resend a persisted attempt-started acknowledgement during recovery", async () => {
		const file = path.join(mkdtempSync(path.join(tmpdir(), "gate-recovery-started-")), "gates.json");
		const store = new FileGateStore(file);
		const initialBroker = new WorkflowGateBroker("run-recovery-started", store, {
			advance: () => {
				throw new Error("simulated crash before advance");
			},
		});
		const gate = initialBroker.openGate({ stage: "deep-interview", kind: "question", schema: { type: "string" } });
		await expect(
			initialBroker.resolve(
				{ gate_id: gate.gate_id, answer: "yes" },
				{
					semanticDisposition: "commit",
					resolutionOrigin: { kind: "telegram_notification", interactionActionId: "interaction-1" },
					ackPolicy: {
						kind: "telegram_selected_v1",
						commitKey: "commit-1",
						actionId: "interaction-1",
						state: "attempt_started",
						updatedAt: "started",
					},
				},
			),
		).rejects.toThrow("simulated crash");

		let recoveryCalls = 0;
		const plane = new UnattendedSessionControlPlane({
			runId: "run-recovery-started",
			sessionId: "session-1",
			store: new FileGateStore(file),
			emitFrame: () => {},
			providerSupportsTokenCostMetrics: true,
		});
		plane.setAckRecoveryParticipant({
			requestRecoveredAskSelectedAck: async () => {
				recoveryCalls++;
				return { status: "delivered", messageId: 42 };
			},
		});
		plane.negotiate(DECL);
		await plane.startRecoveryOnce({ participantGraceMs: 0 });

		expect(recoveryCalls).toBe(0);
		expect(new FileGateStore(file).get(gate.gate_id)).toMatchObject({
			advanced: true,
			ackPolicy: {
				state: "unknown",
				outcome: { status: "unknown", reason: "shutdown" },
			},
		});
	});

	it("does not acknowledge clarification or generic RPC commits", async () => {
		const emitted: RpcWorkflowGate[] = [];
		let acknowledgementCalls = 0;
		let recoveryCalls = 0;
		const plane = new UnattendedSessionControlPlane({
			runId: "run-notification-noncommit",
			sessionId: "session-1",
			emitFrame: gate => emitted.push(gate),
			providerSupportsTokenCostMetrics: true,
		});
		plane.setAckRecoveryParticipant({
			requestRecoveredAskSelectedAck: async () => {
				recoveryCalls += 1;
				return { status: "delivered", messageId: 1 };
			},
		});
		plane.negotiate(DECL);
		const clarificationPending = plane.emitGate(
			questionToGate({ id: "clarify", question: "auth?", options: [{ label: "JWT" }] }),
		);
		const clarificationGate = emitted[0]!;
		await plane.resolveGateFromNotification(
			{ gate_id: clarificationGate.gate_id, answer: { action: "clarify", question: "What is JWT?" } },
			{
				interactionActionId: "interaction-clarify",
				replyReceiptId: "receipt-clarify",
				answerJson: JSON.stringify({ action: "clarify", question: "What is JWT?" }),
				requestSelectedAck: async () => {
					acknowledgementCalls += 1;
					return { status: "delivered", messageId: 2 };
				},
				resolveClaim: () => {},
				closeClaimInvalid: () => {},
			},
		);
		await expect(clarificationPending).resolves.toEqual({ action: "clarify", question: "What is JWT?" });
		const genericPending = plane.emitGate(
			questionToGate({ id: "generic", question: "auth?", options: [{ label: "JWT" }] }),
		);
		const genericGate = emitted[1]!;
		await plane.resolveGate({ gate_id: genericGate.gate_id, answer: { selected: ["JWT"] } });
		await expect(genericPending).resolves.toEqual({ selected: ["JWT"] });
		expect(acknowledgementCalls).toBe(0);
		expect(recoveryCalls).toBe(0);
	});
	it("does not block accepted workflow advancement when claim settlement throws", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
		const gate = emitted[0]!;
		await expect(
			plane.resolveGateFromNotification(
				{ gate_id: gate.gate_id, answer: { selected: ["JWT"] } },
				{
					interactionActionId: "interaction-1",
					replyReceiptId: "receipt-1",
					answerJson: "0",
					requestSelectedAck: async () => ({ status: "delivered", messageId: 42 }),
					resolveClaim: () => {
						throw new Error("native settlement failed");
					},
					closeClaimInvalid: () => {},
				},
			),
		).resolves.toMatchObject({ status: "accepted" });
		await expect(pending).resolves.toEqual({ selected: ["JWT"] });
	});

	for (const scenario of [
		{ name: "failed", outcome: { status: "failed" as const, reason: "telegram_rejected" as const } },
		{ name: "unknown", outcome: { status: "unknown" as const, reason: "host_timeout" as const } },
	]) {
		it(`continues an accepted notification exactly once when acknowledgement is ${scenario.name}`, async () => {
			const { plane, emitted } = makePlane();
			plane.negotiate(DECL);
			let acknowledgements = 0;
			let claims = 0;
			let completions = 0;
			plane.registerGateTerminalController({
				completeGateInteractions: () => {
					completions++;
				},
				cancelGateInteractions: () => {},
			});
			const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
			const gate = emitted[0]!;
			await expect(
				plane.resolveGateFromNotification(
					{ gate_id: gate.gate_id, answer: { selected: ["JWT"] }, idempotency_key: "answer-1" },
					{
						interactionActionId: "interaction-1",
						replyReceiptId: "receipt-1",
						answerJson: "0",
						idempotencyKey: "answer-1",
						requestSelectedAck: async () => {
							acknowledgements++;
							return scenario.outcome;
						},
						resolveClaim: () => {
							claims++;
						},
						closeClaimInvalid: () => {},
					},
				),
			).resolves.toMatchObject({ status: "accepted" });
			await expect(pending).resolves.toEqual({ selected: ["JWT"] });
			expect({ acknowledgements, claims, completions }).toEqual({ acknowledgements: 1, claims: 1, completions: 1 });
		});
	}

	it("settles a replayed notification claim without repeating acknowledgement", async () => {
		const { plane, emitted } = makePlane();
		plane.negotiate(DECL);
		const pending = plane.emitGate(questionToGate({ id: "q", question: "auth?", options: [{ label: "JWT" }] }));
		const gate = emitted[0]!;
		let acknowledgements = 0;
		let claims = 0;
		const resolve = (receiptId: string) =>
			plane.resolveGateFromNotification(
				{ gate_id: gate.gate_id, answer: { selected: ["JWT"] }, idempotency_key: "answer-1" },
				{
					interactionActionId: "interaction-1",
					replyReceiptId: receiptId,
					answerJson: "0",
					idempotencyKey: "answer-1",
					requestSelectedAck: async () => {
						acknowledgements++;
						return { status: "delivered" as const, messageId: 42 };
					},
					resolveClaim: () => {
						claims++;
					},
					closeClaimInvalid: () => {},
				},
			);

		await expect(resolve("receipt-1")).resolves.toMatchObject({ status: "accepted" });
		await expect(pending).resolves.toEqual({ selected: ["JWT"] });
		await expect(resolve("receipt-replay")).resolves.toMatchObject({ status: "accepted" });
		expect(acknowledgements).toBe(1);
		expect(claims).toBe(2);
	});

	it("closes notification claims submitted after disposal", async () => {
		const { plane } = makePlane();
		plane.dispose();
		const closed: string[] = [];
		await expect(
			plane.resolveGateFromNotification(
				{ gate_id: "unknown", answer: { selected: ["JWT"] } },
				{
					interactionActionId: "interaction-1",
					replyReceiptId: "receipt-1",
					answerJson: "0",
					requestSelectedAck: async () => ({ status: "delivered", messageId: 42 }),
					resolveClaim: () => {},
					closeClaimInvalid: reason => closed.push(reason),
				},
			),
		).rejects.toThrow("disposed");
		expect(closed).toEqual(["unattended_session_disposed"]);
		await expect(plane.emitGate(approvalGate())).rejects.toThrow("disposed");
	});
});

describe("modelSupportsTokenCostMetrics", () => {
	it("fails closed for an undefined model", () => {
		expect(modelSupportsTokenCostMetrics(undefined)).toBe(false);
	});

	it("supports a model with no compat overrides", () => {
		expect(modelSupportsTokenCostMetrics({} as never)).toBe(true);
	});

	it("supports a model whose compat enables streaming usage", () => {
		expect(modelSupportsTokenCostMetrics({ compat: { supportsUsageInStreaming: true } } as never)).toBe(true);
	});

	it("fails closed for a model that suppresses streaming usage", () => {
		expect(modelSupportsTokenCostMetrics({ compat: { supportsUsageInStreaming: false } } as never)).toBe(false);
	});
});
