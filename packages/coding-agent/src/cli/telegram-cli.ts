/**
 * `skc telegram` command handlers — start/status/env for the Telegram Remote
 * integration, driven entirely by the `telegram.*` settings group.
 */

import { logger } from "@sayknow-cli/utils";
import { resolveSkcRuntimeSpawnInfo } from "../daemon/runtime";
import { isSettingsInitialized, Settings, settings } from "../config/settings";
import type { TelegramSettings } from "../config/settings-schema";
import { telegramSettingsToEnv, validateTelegramSettings } from "../config/telegram-env-bridge";

export type TelegramAction = "start" | "status" | "env" | "__gateway";

export interface TelegramCommandArgs {
	action: TelegramAction;
	flags: {
		json?: boolean;
	};
}

export const TELEGRAM_ACTIONS: readonly TelegramAction[] = ["start", "status", "env", "__gateway"];

/** Read the full telegram settings group from the settings singleton. */
function readTelegramSettings(): TelegramSettings {
	return {
		enabled: settings.get("telegram.enabled"),
		botToken: settings.get("telegram.botToken"),
		allowedUserIds: settings.get("telegram.allowedUserIds"),
		allowedChatIds: settings.get("telegram.allowedChatIds"),
		backend: settings.get("telegram.backend"),
		enableStop: settings.get("telegram.enableStop"),
		enableRich: settings.get("telegram.enableRich"),
		enablePush: settings.get("telegram.enablePush"),
		registerCommands: settings.get("telegram.registerCommands"),
		presets: settings.get("telegram.presets"),
		rpcSocket: settings.get("telegram.rpcSocket"),
		stateDir: settings.get("telegram.stateDir"),
		pollTimeoutSec: settings.get("telegram.pollTimeoutSec"),
		apiBase: settings.get("telegram.apiBase"),
		coordinatorCommand: settings.get("telegram.coordinatorCommand") ?? "skc",
		coordinatorArgs: settings.get("telegram.coordinatorArgs") ?? "mcp-serve,coordinator",
		enableEditMessageText: settings.get("telegram.enableEditMessageText"),
		richCallbackTtlMs: settings.get("telegram.richCallbackTtlMs"),
		richCallbackMaxTokens: settings.get("telegram.richCallbackMaxTokens"),
		defaultTaskMaxLen: settings.get("telegram.defaultTaskMaxLen"),
		livenessMs: settings.get("telegram.livenessMs"),
		followTtlMs: settings.get("telegram.followTtlMs"),
		subscriptionsMax: settings.get("telegram.subscriptionsMax"),
		longPollMs: settings.get("telegram.longPollMs"),
		digestThreshold: settings.get("telegram.digestThreshold"),
		allowAttachSocketArg: settings.get("telegram.allowAttachSocketArg"),
	};
}

/** Resolve the gateway spawn command by re-invoking skc's own hidden
 *  `telegram __gateway` subcommand: a compiled binary self-spawns the bundled
 *  gateway entrypoint, and a source run re-executes cli.ts under bun. */
function resolveGatewayCommand(): { cmd: string; args: string[] } {
	const rt = resolveSkcRuntimeSpawnInfo();
	return { cmd: rt.execPath, args: [...rt.argsPrefix, "telegram", "__gateway"] };
}

async function runStart(): Promise<void> {
	const config = readTelegramSettings();

	if (!config.enabled) {
		process.stderr.write(
			"Telegram Remote is disabled. Enable it in Settings → Integrations, or set telegram.enabled.\n",
		);
		process.exit(1);
	}

	const errors = validateTelegramSettings(config);
	if (errors.length > 0) {
		process.stderr.write("Telegram configuration is incomplete:\n");
		for (const err of errors) process.stderr.write(`  • ${err}\n`);
		process.exit(1);
	}

	const env = telegramSettingsToEnv(config);
	const { cmd, args } = resolveGatewayCommand();

	logger.info("telegram-remote starting", { cmd });

	const proc = Bun.spawn([cmd, ...args], {
		env: { ...process.env, ...env },
		stdio: ["inherit", "inherit", "inherit"],
	});

	// Forward termination signals to the child.
	const forward = (sig: NodeJS.Signals): void => void proc.kill(sig);
	process.on("SIGINT", forward);
	process.on("SIGTERM", forward);

	const code = await proc.exited;
	process.off("SIGINT", forward);
	process.off("SIGTERM", forward);
	process.exit(code);
}

async function runStatus(flags: TelegramCommandArgs["flags"]): Promise<void> {
	const config = readTelegramSettings();
	const errors = config.enabled ? validateTelegramSettings(config) : [];

	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ enabled: config.enabled, valid: errors.length === 0, errors })}\n`);
		return;
	}

	process.stdout.write(`Telegram Remote: ${config.enabled ? "enabled" : "disabled"}\n`);
	process.stdout.write(`Backend: ${config.backend}\n`);

	if (config.botToken) process.stdout.write(`Bot Token: ✓ set\n`);
	else process.stdout.write(`Bot Token: ✗ missing\n`);

	if (config.allowedUserIds || config.allowedChatIds) {
		process.stdout.write(`Allowlist: ✓ configured\n`);
	} else {
		process.stdout.write(`Allowlist: ✗ missing\n`);
	}

	if (errors.length > 0) {
		process.stdout.write("\nConfiguration issues:\n");
		for (const err of errors) process.stdout.write(`  • ${err}\n`);
	}
}

async function runEnv(): Promise<void> {
	const config = readTelegramSettings();
	const env = telegramSettingsToEnv(config);
	for (const [key, value] of Object.entries(env)) {
		process.stdout.write(`${key}=${value}\n`);
	}
}

export async function runTelegramCommand(cmd: TelegramCommandArgs): Promise<void> {
	if (!isSettingsInitialized()) await Settings.init();
	switch (cmd.action) {
		case "start":
			await runStart();
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "env":
			await runEnv();
			return;
		case "__gateway": {
			// Hidden entrypoint: run the Telegram Remote gateway in-process. Reached
			// only via the self-spawn from runStart()/autostart, never by users.
			const { loadConfigFromEnv, runService } = await import("../../../telegram-remote/src/index");
			await runService(loadConfigFromEnv(process.env));
			return;
		}
	}
}
