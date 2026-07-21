/**
 * Session-level unattended control plane (#323 / G011 emission side).
 *
 * Bridges the gate EMISSION side (skill runtimes / ask tool emitting gates) to
 * the gate ANSWER side (the external agent's `workflow_gate_response` over RPC):
 *
 *  - `emitGate(input)` opens a gate on the durable broker, emits the gate frame
 *    to the transport, and returns a promise that resolves with the agent's
 *    answer once it arrives.
 *  - `resolveGate(response)` (called from RPC dispatch) validates + resolves the
 *    gate on the broker; the broker's `advance` hook resolves the pending
 *    `emitGate` promise with the answer.
 *
 * Also implements the dispatch-facing {@link RpcUnattendedControlPlane} so the
 * RPC server can route `negotiate_unattended` + `workflow_gate_response` here.
 */
import type { Model } from "@sayknow-cli/ai";
import type { AskSelectedAckOutcome } from "../../../tools";
import type {
	RpcCommand,
	RpcUnattendedAccepted,
	RpcUnattendedDeclaration,
	RpcWorkflowGate,
	RpcWorkflowGateResolution,
	RpcWorkflowGateResponse,
} from "../../rpc/rpc-types";
import type { RpcUnattendedControlPlane } from "./command-dispatch";
import { scopeForRpcCommand } from "./scopes";
import {
	type UnattendedAbortHooks,
	type UnattendedAuditEvent,
	UnattendedRunController,
} from "./unattended-run-controller";
import {
	type GateStore,
	MemoryGateStore,
	type OpenGateInput,
	type PersistedAckPolicy,
	type PersistedGate,
	type PersistedSemanticDisposition,
	WorkflowGateBroker,
} from "./workflow-gate-broker";

export interface WorkflowGateTerminalController {
	completeGateInteractions(gateId: string): void | Promise<void>;
	cancelGateInteractions(gateId: string, reason: string): void | Promise<void>;
}

export interface WorkflowGateTerminalEvent {
	gateId: string;
	kind: "accepted" | "cancelled";
	origin?: "rpc" | "bridge" | "other" | "telegram_notification";
	reason?: string;
}

export interface NotificationGateResolutionOptions {
	interactionActionId: string;
	replyReceiptId: string;
	answerJson: string;
	idempotencyKey?: string;
	requestSelectedAck(input: {
		replyReceiptId: string;
		actionId: string;
		commitKey: string;
		daemonDeadlineAt: number;
		hostTimeoutMs: number;
	}): Promise<AskSelectedAckOutcome>;
	resolveClaim(): void;
	closeClaimInvalid(reason: string): void;
}

export interface AskSelectedAckRecoveryParticipant {
	requestRecoveredAskSelectedAck(input: {
		sessionId: string;
		actionId: string;
		commitKey: string;
		deadlineAt: number;
		hostTimeoutMs: number;
	}): Promise<AskSelectedAckOutcome>;
}

/**
 * RPC commands that perform agent/tool work and therefore consume one unit of the
 * `max_tool_calls` budget. Read-only/control/cancellation commands are wall-time-bounded
 * and scope-checked but must NOT charge the tool-call budget (issue 04).
 */
const CHARGED_COMMAND_TYPES = new Set<RpcCommand["type"]>(["bash", "prompt", "steer", "follow_up", "abort_and_prompt"]);

/**
 * Derive an explicit `providerSupportsTokenCostMetrics` capability from the
 * active model so unattended negotiation fails closed when token/cost usage
 * cannot be accounted for (#606). Callers that omit a model — or whose model is
 * configured to suppress streaming usage (`compat.supportsUsageInStreaming:
 * false`) — get `false`, which the controller refuses with
 * `unsupported_budget_metric`.
 */
export function modelSupportsTokenCostMetrics(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat as { supportsUsageInStreaming?: boolean } | undefined;
	return compat?.supportsUsageInStreaming !== false;
}

/** Minimal surface a skill runtime / ask tool uses to emit a gate and await its answer. */
export interface WorkflowGateEmitter {
	/** True only when unattended mode has been negotiated. */
	isUnattended(): boolean;
	/** Open + emit a gate; resolves with the agent's answer (from workflow_gate_response). */
	emitGate(input: OpenGateInput): Promise<unknown>;
	/**
	 * Optional bridge surface (present on {@link UnattendedSessionControlPlane}) that
	 * lets an in-process extension observe emitted gates and answer them — used by
	 * the notifications SDK to resolve a real ask gate from a remote reply.
	 */
	onGateEmitted?(listener: (gate: RpcWorkflowGate) => void): () => void;
	resolveGate?(response: RpcWorkflowGateResponse): Promise<RpcWorkflowGateResolution>;
	resolveGateFromNotification?(
		response: RpcWorkflowGateResponse,
		options: NotificationGateResolutionOptions,
	): Promise<RpcWorkflowGateResolution>;
	registerGateTerminalController?(controller: WorkflowGateTerminalController): () => void;
	listPendingGates?(): RpcWorkflowGate[];
	setAckRecoveryParticipant?(participant: AskSelectedAckRecoveryParticipant | null): void;
}

export interface UnattendedSessionOptions {
	runId: string;
	sessionId?: string;
	/** Emit a workflow_gate frame to the transport so the agent receives it. */
	emitFrame: (gate: RpcWorkflowGate) => void;
	/** Durable gate store; defaults to in-memory. */
	store?: GateStore;
	/** Audit sink for controller + gate events. */
	audit?: (event: UnattendedAuditEvent | { event: string; [k: string]: unknown }) => void;
	abortHooks?: UnattendedAbortHooks;
	/** Whether the active provider reports token/cost usage (fail-closed when false/omitted). */
	providerSupportsTokenCostMetrics?: boolean;
	/** Snapshot live cumulative usage after a dispatch or turn, for budget reconciliation. */
	getUsageSnapshot?: () => { tokens?: number; costUsd?: number };
}

export class UnattendedSessionControlPlane implements RpcUnattendedControlPlane, WorkflowGateEmitter {
	#controller: UnattendedRunController | undefined;
	#broker: WorkflowGateBroker | undefined;
	readonly #pending = new Map<string, { resolve: (answer: unknown) => void; reject: (err: Error) => void }>();
	readonly #earlyAnswers = new Map<string, unknown>();
	readonly #gateListeners = new Set<(gate: RpcWorkflowGate) => void>();
	#terminalController: WorkflowGateTerminalController | undefined;
	#brokerReady = false;
	#recoveryPromise: Promise<void> | undefined;
	#disposed = false;
	#recoveryParticipant: AskSelectedAckRecoveryParticipant | undefined;
	#participantReady = Promise.withResolvers<void>();

	constructor(private readonly opts: UnattendedSessionOptions) {}

	isUnattended(): boolean {
		return this.#controller !== undefined;
	}

	/** Observe every emitted gate (e.g. so an extension can map an ask to its gate_id). */
	onGateEmitted(listener: (gate: RpcWorkflowGate) => void): () => void {
		this.#gateListeners.add(listener);
		return () => this.#gateListeners.delete(listener);
	}

	get controller(): UnattendedRunController | undefined {
		return this.#controller;
	}

	registerGateTerminalController(controller: WorkflowGateTerminalController): () => void {
		if (this.#terminalController && this.#terminalController !== controller) {
			throw new Error("a workflow gate terminal controller is already registered");
		}
		this.#terminalController = controller;
		return () => {
			if (this.#terminalController === controller) this.#terminalController = undefined;
		};
	}

	setAckRecoveryParticipant(participant: AskSelectedAckRecoveryParticipant | null): void {
		this.#recoveryParticipant = participant ?? undefined;
		if (participant) this.#participantReady.resolve();
		void this.startRecoveryOnce();
	}

	async #completeGateInteractions(gateId: string): Promise<void> {
		try {
			await this.#terminalController?.completeGateInteractions(gateId);
		} catch (error) {
			this.opts.audit?.({ event: "gate_interaction_completion_failed", gate_id: gateId, error: String(error) });
		}
	}

	async #cancelGateInteractions(gateId: string, reason: string): Promise<void> {
		try {
			await this.#terminalController?.cancelGateInteractions(gateId, reason);
		} catch (error) {
			this.opts.audit?.({ event: "gate_interaction_cancellation_failed", gate_id: gateId, error: String(error) });
		}
	}

	negotiate(declaration: RpcUnattendedDeclaration): RpcUnattendedAccepted {
		const controller = UnattendedRunController.negotiate(declaration, {
			runId: this.opts.runId,
			sessionId: this.opts.sessionId,
			audit: this.opts.audit,
			abortHooks: {
				...this.opts.abortHooks,
				// On abort (e.g. wall-time / budget breach) reject any gate still
				// awaiting an answer, so emitGate cannot hang forever.
				stopWorkflow: async reason => {
					await this.opts.abortHooks?.stopWorkflow?.(reason);
					this.#rejectAllPending(new Error(`unattended run aborted: ${reason}`));
				},
			},
			providerSupportsTokenCostMetrics: this.opts.providerSupportsTokenCostMetrics,
		});
		this.#controller = controller;
		this.#broker = new WorkflowGateBroker(this.opts.runId, this.opts.store ?? new MemoryGateStore(), {
			emit: gate => this.opts.emitFrame(gate),
			audit: e => this.opts.audit?.(e),
			advance: (gate, answer) => {
				const pending = this.#pending.get(gate.gate_id);
				if (pending) {
					this.#pending.delete(gate.gate_id);
					pending.resolve(answer);
					return;
				}
				// A controller may answer synchronously while emitFrame is still on the
				// stack. Keep the accepted answer so emitGate can still resolve after
				// openGate returns and the caller starts awaiting.
				this.#earlyAnswers.set(gate.gate_id, answer);
			},
			finalizeAccepted: record => this.#finalizeAcceptedGate(record),
		});
		this.#brokerReady = true;
		void this.startRecoveryOnce();

		return {
			run_id: this.opts.runId,
			actor: controller.actor,
			budget: controller.budget,
			scopes: [...controller.scopes],
			action_allowlist: [...controller.actionAllowlist],
			accepted_at: new Date().toISOString(),
		};
	}

	preflightCommand(command: RpcCommand): void {
		if (!this.#controller) return;
		const phase = `${command.type} preflight`;
		// Always enforce wall-time; only charge the tool-call budget for commands that perform
		// agent/tool work (issue 04). Read-only/control/cancellation commands must not consume
		// max_tool_calls, but remain wall-time-bounded and scope/action-checked.
		if (CHARGED_COMMAND_TYPES.has(command.type)) {
			this.#controller.preflightToolCall(phase);
		} else {
			this.#controller.checkWallTime(phase);
		}
		if (command.type === "bash") {
			this.#controller.authorizeBash(command.command);
			return;
		}
		const scope = scopeForRpcCommand(command.type);
		this.#controller.authorizeScope(scope);
		this.#controller.authorizeAction(UnattendedRunController.actionClassForScope(scope));
	}

	reconcileUsage(phase = "unattended usage reconciliation"): void {
		const controller = this.#controller;
		if (!controller) return;
		controller.checkWallTime(phase);
		const snapshot = this.opts.getUsageSnapshot?.();
		if (!snapshot) return;
		const current = controller.usageSnapshot();
		const tokens = snapshot.tokens;
		const costUsd = snapshot.costUsd;
		controller.reconcile(
			{
				tokens: tokens !== undefined ? Math.max(0, tokens - current.tokens) : undefined,
				costUsd: costUsd !== undefined ? Math.max(0, costUsd - current.costUsd) : undefined,
			},
			phase,
		);
	}

	resolveGate(response: RpcWorkflowGateResponse): Promise<RpcWorkflowGateResolution> {
		if (this.#disposed) return Promise.reject(new Error("unattended session is disposed"));
		if (!this.#broker) {
			return Promise.reject(new Error("workflow gates are not available until unattended mode is negotiated"));
		}
		return this.#broker.resolve(response);
	}

	async resolveGateFromNotification(
		response: RpcWorkflowGateResponse,
		options: NotificationGateResolutionOptions,
	): Promise<RpcWorkflowGateResolution> {
		let claimSettled = false;
		const resolveClaim = () => {
			if (claimSettled) return;
			claimSettled = true;
			try {
				options.resolveClaim();
			} catch (error) {
				this.opts.audit?.({
					event: "notification_claim_resolution_failed",
					gate_id: response.gate_id,
					error: String(error),
				});
			}
		};
		const closeClaimInvalid = (reason: string) => {
			if (claimSettled) return;
			claimSettled = true;
			try {
				options.closeClaimInvalid(reason);
			} catch (error) {
				this.opts.audit?.({
					event: "notification_claim_close_failed",
					gate_id: response.gate_id,
					error: String(error),
				});
			}
		};
		if (this.#disposed) {
			closeClaimInvalid("unattended_session_disposed");
			throw new Error("unattended session is disposed");
		}
		if (!this.#broker) {
			closeClaimInvalid("workflow_gate_unavailable");
			throw new Error("workflow gates are not available until unattended mode is negotiated");
		}
		try {
			JSON.parse(options.answerJson);
		} catch {
			closeClaimInvalid("invalid_structured_answer");
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: "",
				resolved_at: new Date().toISOString(),
				error: this.#broker.validationError(response.gate_id, "json_parse", "invalid structured answer"),
			};
		}
		let disposition: PersistedSemanticDisposition;
		try {
			disposition = this.#broker.classifyDisposition(response.gate_id, response.answer);
		} catch (error) {
			closeClaimInvalid(error instanceof Error ? error.message : "invalid_answer");
			return {
				gate_id: response.gate_id,
				status: "rejected",
				answer_hash: "",
				resolved_at: new Date().toISOString(),
				error: this.#broker.validationError(
					response.gate_id,
					"semantic_disposition",
					error instanceof Error ? error.message : "invalid answer",
				),
			};
		}

		const commitKey = `${response.gate_id}:${options.idempotencyKey ?? options.replyReceiptId}`;
		const ackPolicy: PersistedAckPolicy =
			disposition === "commit"
				? {
						kind: "telegram_selected_v1",
						commitKey,
						actionId: options.interactionActionId,
						state: "pending",
						updatedAt: new Date().toISOString(),
					}
				: { kind: "none", reason: "semantic_noncommit" };
		let resolution: RpcWorkflowGateResolution;
		try {
			resolution = await this.#broker.resolve(response, {
				resolutionOrigin: { kind: "telegram_notification", interactionActionId: options.interactionActionId },
				ackPolicy,
				semanticDisposition: disposition,

				beforeAdvance: async () => {
					if (ackPolicy.kind === "telegram_selected_v1") {
						this.#broker?.updateAckPolicy(response.gate_id, {
							...ackPolicy,
							state: "attempt_started",
							updatedAt: new Date().toISOString(),
						});
						let outcome: AskSelectedAckOutcome;
						try {
							outcome = await options.requestSelectedAck({
								replyReceiptId: options.replyReceiptId,
								actionId: options.interactionActionId,
								commitKey,
								daemonDeadlineAt: Date.now() + 8_000,
								hostTimeoutMs: 10_000,
							});
						} catch {
							outcome = { status: "unknown", reason: "host_timeout" };
						}
						this.#broker?.updateAckPolicy(response.gate_id, {
							...ackPolicy,
							state: outcome.status,
							outcome,
							updatedAt: new Date().toISOString(),
						});
					}
					resolveClaim();
				},
			});
		} catch (error) {
			closeClaimInvalid(error instanceof Error ? error.message : "invalid_answer");
			throw error;
		}
		if (resolution.status === "accepted") resolveClaim();
		else closeClaimInvalid(resolution.error?.code ?? "invalid_answer");
		return resolution;
	}

	async startRecoveryOnce(options: { participantGraceMs?: number } = {}): Promise<void> {
		if (this.#disposed || !this.#brokerReady) return;
		if (this.#recoveryPromise) return this.#recoveryPromise;
		this.#recoveryPromise = (async () => {
			if (!this.#recoveryParticipant) {
				const grace = options.participantGraceMs ?? 2_000;
				await Promise.race([
					this.#participantReady.promise,
					new Promise<void>(resolve => setTimeout(resolve, grace)),
				]);
			}
			if (!this.#disposed) await this.#broker?.recover();
		})();
		return this.#recoveryPromise;
	}

	async #finalizeAcceptedGate(record: PersistedGate): Promise<void> {
		const policy = record.ackPolicy;
		if (policy?.kind === "telegram_selected_v1" && policy.state === "pending") {
			let outcome: AskSelectedAckOutcome;
			const participant = this.#recoveryParticipant;
			if (!participant || !this.opts.sessionId) {
				outcome = { status: "failed", reason: "no_participant" };
			} else {
				this.#broker?.updateAckPolicy(record.gate.gate_id, {
					...policy,
					state: "attempt_started",
					updatedAt: new Date().toISOString(),
				});
				try {
					outcome = await participant.requestRecoveredAskSelectedAck({
						sessionId: this.opts.sessionId,
						actionId: policy.actionId,
						commitKey: policy.commitKey,
						deadlineAt: Date.now() + 8_000,
						hostTimeoutMs: 10_000,
					});
				} catch {
					outcome = { status: "unknown", reason: "host_timeout" };
				}
			}
			this.#broker?.updateAckPolicy(record.gate.gate_id, {
				...policy,
				state: outcome.status,
				outcome,
				updatedAt: new Date().toISOString(),
			});
		}
		if (policy?.kind === "telegram_selected_v1" && policy.state === "attempt_started") {
			this.#broker?.updateAckPolicy(record.gate.gate_id, {
				...policy,
				state: "unknown",
				outcome: { status: "unknown", reason: "shutdown" },
				updatedAt: new Date().toISOString(),
			});
		}
		await this.#completeGateInteractions(record.gate.gate_id);
	}

	dispose(reason = "session_shutdown"): void {
		this.#disposed = true;
		for (const gateId of this.#pending.keys()) void this.#cancelGateInteractions(gateId, reason);
		this.#rejectAllPending(new Error(`unattended session disposed: ${reason}`));
	}

	listPendingGates(): import("../../rpc/rpc-types").RpcWorkflowGate[] {
		const store = this.opts.store;
		if (!store) return [];
		return store
			.list()
			.filter(record => record.status === "pending")
			.map(record => record.gate);
	}

	emitGate(input: OpenGateInput): Promise<unknown> {
		if (this.#disposed) return Promise.reject(new Error("unattended session is disposed"));
		if (!this.#broker) {
			return Promise.reject(new Error("cannot emit a workflow gate before unattended mode is negotiated"));
		}
		const gate = this.#broker.openGate(input);
		for (const listener of this.#gateListeners) {
			try {
				listener(gate);
			} catch {
				// A misbehaving observer must never break gate emission.
			}
		}
		if (this.#earlyAnswers.has(gate.gate_id)) {
			const answer = this.#earlyAnswers.get(gate.gate_id);
			this.#earlyAnswers.delete(gate.gate_id);
			return Promise.resolve(answer);
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(gate.gate_id, { resolve, reject });
		return promise;
	}

	async recover(): Promise<void> {
		await this.#broker?.recover();
	}

	#rejectAllPending(error: Error): void {
		this.#earlyAnswers.clear();
		for (const [gateId, pending] of this.#pending) {
			this.#pending.delete(gateId);
			pending.reject(error);
		}
	}
}
