import type { SkcTeamConfig, SkcTeamMailboxMessage } from "./team-runtime";
import type {
	SkcTeamMailboxDeliveryInput,
	SkcTeamMailboxDeliveryResult,
	SkcTeamMailboxDeliveryTransport,
	SkcTeamNotification,
	SkcTeamNotificationDeliveryState,
	SkcTeamNotificationSummary,
	SkcTeamPaneAttemptResult,
} from "./team-store";

/** Runtime-owned filesystem and participant operations used by notification delivery. */
export interface TeamNotificationRuntime {
	findTeamDir(teamName: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string>;
	readConfig(dir: string): Promise<SkcTeamConfig>;
	assertKnownParticipant(config: SkcTeamConfig, participant: string): void;
	messageId(input: {
		teamName: string;
		fromWorker: string;
		toWorker: string;
		body: string;
		idempotencyKey?: string;
		createdKey: string;
	}): string;
	messageNotificationId(teamName: string, recipient: string, messageId: string): string;
	now(): string;
	randomId(): string;
	appendEvent(
		dir: string,
		event: {
			type: string;
			worker?: string;
			message?: string;
			data?: Record<string, unknown>;
		},
	): Promise<void>;
	readMailbox(dir: string, worker: string): Promise<{ messages: SkcTeamMailboxMessage[] }>;
	writeMailboxMessage(dir: string, worker: string, message: SkcTeamMailboxMessage): Promise<SkcTeamMailboxMessage>;
	listNotifications(dir: string): Promise<SkcTeamNotification[]>;
	readNotification(dir: string, id: string): Promise<SkcTeamNotification>;
	writeNotification(dir: string, notification: SkcTeamNotification): Promise<SkcTeamNotification>;
}

export async function deliverTeamMailboxMessage(
	transport: SkcTeamMailboxDeliveryTransport | undefined,
	input: SkcTeamMailboxDeliveryInput,
): Promise<SkcTeamMailboxDeliveryResult | null> {
	if (!transport) return null;
	try {
		return await transport.deliverMailboxMessage(input);
	} catch {
		return null;
	}
}

export function emptyTeamNotificationSummary(): SkcTeamNotificationSummary {
	return {
		total: 0,
		replay_eligible: 0,
		by_state: {
			pending: 0,
			sent: 0,
			queued: 0,
			deferred: 0,
			failed: 0,
			delivered: 0,
			acknowledged: 0,
		},
	};
}

export function isReplayEligibleTeamNotification(state: SkcTeamNotificationDeliveryState): boolean {
	return state === "pending" || state === "queued" || state === "deferred" || state === "failed";
}

export function summarizeTeamNotifications(notifications: SkcTeamNotification[]): SkcTeamNotificationSummary {
	const summary = emptyTeamNotificationSummary();
	for (const notification of notifications) {
		summary.total += 1;
		summary.by_state[notification.delivery_state] += 1;
		if (isReplayEligibleTeamNotification(notification.delivery_state)) summary.replay_eligible += 1;
	}
	return summary;
}

export async function createTeamMessageNotification(
	runtime: TeamNotificationRuntime,
	dir: string,
	teamName: string,
	message: SkcTeamMailboxMessage,
	state: SkcTeamNotificationDeliveryState = "pending",
): Promise<SkcTeamNotification> {
	return runtime.writeNotification(dir, {
		id: runtime.messageNotificationId(teamName, message.to_worker, message.message_id),
		kind: "mailbox_message",
		team_name: teamName,
		recipient: message.to_worker,
		source: { type: "message", id: message.message_id },
		idempotency_key: message.idempotency_key,
		delivery_state: state,
		created_at: message.created_at,
		updated_at: runtime.now(),
		replay_count: 0,
	});
}

export async function reconcileTeamNotifications(
	runtime: TeamNotificationRuntime,
	dir: string,
	config: SkcTeamConfig,
): Promise<SkcTeamNotificationSummary> {
	for (const recipient of ["leader-fixed", ...config.workers.map(worker => worker.id)]) {
		for (const message of (await runtime.readMailbox(dir, recipient)).messages) {
			await createTeamMessageNotification(
				runtime,
				dir,
				config.team_name,
				message,
				message.delivered_at ? "acknowledged" : message.notified_at ? "delivered" : "pending",
			);
		}
	}
	return summarizeTeamNotifications(await runtime.listNotifications(dir));
}

async function attemptConfiguredMailboxTransport(
	runtime: TeamNotificationRuntime,
	dir: string,
	config: SkcTeamConfig,
	notification: SkcTeamNotification,
	cwd: string,
	env: NodeJS.ProcessEnv,
	transport?: SkcTeamMailboxDeliveryTransport,
): Promise<SkcTeamNotification | null> {
	if (notification.kind !== "mailbox_message" || notification.source.type !== "message") return null;
	const message = (await runtime.readMailbox(dir, notification.recipient)).messages.find(
		candidate => candidate.message_id === notification.source.id,
	);
	if (!message) return null;
	const result = await deliverTeamMailboxMessage(transport, {
		team_name: config.team_name,
		state_dir: dir,
		config,
		notification,
		message,
		cwd,
		env,
	});
	if (!result || (result.transport === "sdk" && result.state === "failed")) return null;
	return runtime.writeNotification(dir, {
		...notification,
		delivery_state: result.state,
		pane_attempt_result: result.transport === "pane" ? result.state : undefined,
		pane_attempt_reason: result.reason ?? result.transport,
		pane_attempt_at: runtime.now(),
		updated_at: runtime.now(),
	});
}

async function attemptPaneNotification(
	runtime: TeamNotificationRuntime,
	dir: string,
	config: SkcTeamConfig,
	notification: SkcTeamNotification,
	env: NodeJS.ProcessEnv,
	cwd: string,
	transport?: SkcTeamMailboxDeliveryTransport,
): Promise<SkcTeamNotification> {
	const transported = await attemptConfiguredMailboxTransport(runtime, dir, config, notification, cwd, env, transport);
	if (transported) return transported;
	const paneId =
		notification.recipient === "leader-fixed"
			? config.leader.pane_id
			: config.workers.find(worker => worker.id === notification.recipient)?.pane_id;
	let result: SkcTeamPaneAttemptResult = "deferred";
	let reason = "pane_missing";
	if (paneId) {
		if (config.tmux_session === "dry-run" || env.SKC_TEAM_FAKE_PANE_ATTEMPT === "sent") {
			result = "sent";
			reason = "dry_run_or_fake_tmux";
		} else {
			result = "queued";
			reason = "tmux_delivery_recorded_without_injection";
		}
	}
	return runtime.writeNotification(dir, {
		...notification,
		delivery_state: result,
		pane_attempt_result: result,
		pane_attempt_reason: reason,
		pane_attempt_at: runtime.now(),
		updated_at: runtime.now(),
	});
}

export async function replayTeamNotifications(
	runtime: TeamNotificationRuntime,
	teamName: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	transport?: SkcTeamMailboxDeliveryTransport,
): Promise<{
	notifications: SkcTeamNotification[];
	summary: SkcTeamNotificationSummary;
}> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	await reconcileTeamNotifications(runtime, dir, config);
	const notifications = await Promise.all(
		(await runtime.listNotifications(dir)).map(async notification =>
			isReplayEligibleTeamNotification(notification.delivery_state)
				? attemptPaneNotification(
						runtime,
						dir,
						config,
						{
							...notification,
							replay_count: (notification.replay_count ?? 0) + 1,
						},
						env,
						cwd,
						transport,
					)
				: notification,
		),
	);
	return { notifications, summary: summarizeTeamNotifications(notifications) };
}

export async function sendTeamMessage(
	runtime: TeamNotificationRuntime,
	teamName: string,
	fromWorker: string,
	toWorker: string,
	body: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	idempotencyKey?: string,
	transport?: SkcTeamMailboxDeliveryTransport,
): Promise<SkcTeamMailboxMessage> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	runtime.assertKnownParticipant(config, fromWorker);
	runtime.assertKnownParticipant(config, toWorker);
	const createdKey = idempotencyKey ?? runtime.randomId();
	const message: SkcTeamMailboxMessage = {
		message_id: runtime.messageId({
			teamName: config.team_name,
			fromWorker,
			toWorker,
			body,
			idempotencyKey,
			createdKey,
		}),
		from_worker: fromWorker,
		to_worker: toWorker,
		body,
		created_at: runtime.now(),
		...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
	};
	const written = await runtime.writeMailboxMessage(dir, toWorker, message);
	const existing = (await runtime.listNotifications(dir)).some(
		notification => notification.id === runtime.messageNotificationId(config.team_name, toWorker, written.message_id),
	);
	const notification = await createTeamMessageNotification(runtime, dir, config.team_name, written);
	if (!existing) await attemptPaneNotification(runtime, dir, config, notification, env, cwd, transport);
	await runtime.appendEvent(dir, {
		type: "message_sent",
		worker: fromWorker,
		message: body,
		data: { to_worker: toWorker, message_id: written.message_id },
	});
	return written;
}

export async function listTeamMailbox(
	runtime: TeamNotificationRuntime,
	teamName: string,
	worker: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<SkcTeamMailboxMessage[]> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	runtime.assertKnownParticipant(config, worker);
	return (await runtime.readMailbox(dir, worker)).messages;
}

export async function markTeamMailboxMessage(
	runtime: TeamNotificationRuntime,
	teamName: string,
	worker: string,
	messageId: string,
	field: "delivered_at" | "notified_at",
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<SkcTeamMailboxMessage> {
	const dir = await runtime.findTeamDir(teamName, cwd, env);
	const config = await runtime.readConfig(dir);
	runtime.assertKnownParticipant(config, worker);
	const message = (await runtime.readMailbox(dir, worker)).messages.find(
		candidate => candidate.message_id === messageId,
	);
	if (!message) throw new Error(`message_not_found:${messageId}`);
	const written = await runtime.writeMailboxMessage(dir, worker, {
		...message,
		[field]: message[field] ?? runtime.now(),
	});
	const id = runtime.messageNotificationId(config.team_name, worker, messageId);
	const existing =
		(await runtime.listNotifications(dir)).find(notification => notification.id === id) ??
		(await createTeamMessageNotification(runtime, dir, config.team_name, written));
	const state: SkcTeamNotificationDeliveryState = field === "delivered_at" ? "acknowledged" : "delivered";
	await runtime.writeNotification(dir, {
		...existing,
		delivery_state: state,
		updated_at: runtime.now(),
	});
	if (existing.delivery_state !== state)
		await runtime.appendEvent(dir, {
			type: `message_${field === "delivered_at" ? "acknowledged" : "notified"}`,
			worker,
			message: messageId,
		});
	return written;
}
