/**
 * Bridge between skc settings (`telegram.*`) and the
 * `@sayknow-cli/telegram-remote` gateway's environment-driven config
 * (`loadConfigFromEnv` in packages/telegram-remote/src/config.ts).
 *
 * The gateway is a standalone process (`skc-telegram-remote`) that reads all
 * configuration from `SKC_TELEGRAM_REMOTE_*` env vars. This module converts the
 * typed settings group into those env vars so skc can spawn the gateway with a
 * consistent, settings-page-driven configuration.
 */
import type { TelegramSettings } from "./settings-schema";

/** Convert telegram settings into the env-var map the gateway expects. */
export function telegramSettingsToEnv(s: TelegramSettings): Record<string, string> {
	const env: Record<string, string> = {};

	const str = (v: string | undefined, key: string): void => {
		if (v !== undefined && v !== "") env[key] = v;
	};
	const num = (v: number, key: string): void => {
		env[key] = String(v);
	};
	const bool = (v: boolean, key: string): void => {
		env[key] = v ? "true" : "false";
	};

	// Required
	str(s.botToken, "SKC_TELEGRAM_REMOTE_BOT_TOKEN");

	// Allowlists
	str(s.allowedUserIds, "SKC_TELEGRAM_REMOTE_ALLOWED_USER_IDS");
	str(s.allowedChatIds, "SKC_TELEGRAM_REMOTE_ALLOWED_CHAT_IDS");

	// Presets
	str(s.presets, "SKC_TELEGRAM_REMOTE_PRESETS");

	// Toggles
	bool(s.enableStop, "SKC_TELEGRAM_REMOTE_ENABLE_STOP");
	bool(s.enableRich, "SKC_TELEGRAM_REMOTE_ENABLE_RICH");
	bool(s.enablePush, "SKC_TELEGRAM_REMOTE_ENABLE_PUSH");
	bool(s.registerCommands, "SKC_TELEGRAM_REMOTE_REGISTER_COMMANDS");
	bool(s.enableEditMessageText, "SKC_TELEGRAM_REMOTE_ENABLE_EDIT_MESSAGE_TEXT");
	bool(s.allowAttachSocketArg, "SKC_TELEGRAM_REMOTE_ALLOW_ATTACH_SOCKET_ARG");

	// Backend + RPC
	str(s.backend, "SKC_TELEGRAM_REMOTE_BACKEND");
	str(s.rpcSocket, "SKC_TELEGRAM_REMOTE_RPC_SOCKET");
	str(s.stateDir, "SKC_TELEGRAM_REMOTE_STATE_DIR");
	num(s.livenessMs, "SKC_TELEGRAM_REMOTE_LIVENESS_MS");

	// Transport
	str(s.apiBase, "SKC_TELEGRAM_REMOTE_API_BASE");
	num(s.pollTimeoutSec, "SKC_TELEGRAM_REMOTE_POLL_TIMEOUT_SEC");
	num(s.longPollMs, "SKC_TELEGRAM_REMOTE_WATCH_TIMEOUT_MS");

	// Rich callback tuning
	num(s.richCallbackTtlMs, "SKC_TELEGRAM_REMOTE_RICH_CALLBACK_TTL_MS");
	num(s.richCallbackMaxTokens, "SKC_TELEGRAM_REMOTE_RICH_CALLBACK_MAX_TOKENS");

	// Push / subscriptions
	num(s.followTtlMs, "SKC_TELEGRAM_REMOTE_FOLLOW_TTL_MS");
	num(s.subscriptionsMax, "SKC_TELEGRAM_REMOTE_SUBSCRIPTIONS_MAX");
	num(s.digestThreshold, "SKC_TELEGRAM_REMOTE_DIGEST_THRESHOLD");

	// Coordinator subprocess
	str(s.coordinatorCommand, "SKC_TELEGRAM_REMOTE_COORDINATOR_COMMAND");
	str(s.coordinatorArgs, "SKC_TELEGRAM_REMOTE_COORDINATOR_ARGS");

	// Preset task cap
	num(s.defaultTaskMaxLen, "SKC_TELEGRAM_REMOTE_DEFAULT_TASK_MAX_LEN");

	return env;
}

/**
 * Validate telegram settings before spawning the gateway.
 * Returns a list of human-readable error strings (empty when valid).
 */
export function validateTelegramSettings(s: TelegramSettings): string[] {
	const errors: string[] = [];

	if (!s.botToken) errors.push("Bot Token is required");
	if (!s.allowedUserIds && !s.allowedChatIds) {
		errors.push("At least one of Allowed User IDs or Allowed Chat IDs is required");
	}
	if (s.backend === "rpc") {
		if (!s.rpcSocket) errors.push("RPC Socket is required for the RPC backend");
		if (!s.stateDir) errors.push("State Directory is required for the RPC backend");
	}

	return errors;
}
