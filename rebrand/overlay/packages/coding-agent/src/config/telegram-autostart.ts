/**
 * Auto-start the Telegram Remote gateway when `telegram.enabled` is on.
 *
 * Called once during skc startup (interactive / persistent modes only — not
 * `-p` print or auto-print). Spawns the gateway as a detached background
 * process, tracks its PID so repeated skc invocations don't double-spawn,
 * and redirects output to a log file under the config root.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir, isCompiledBinary, logger } from "@sayknow-cli/utils";
import { settings } from "./settings";
import type { TelegramSettings } from "./settings-schema";
import { telegramSettingsToEnv, validateTelegramSettings } from "./telegram-env-bridge";

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

function resolveGatewayCommand(): { cmd: string; args: string[] } {
	if (isCompiledBinary()) {
		return { cmd: "skc-telegram-remote", args: [] };
	}
	const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../telegram-remote/src/cli.ts");
	return { cmd: process.execPath, args: ["run", cliPath] };
}

function isAlreadyRunning(pidFile: string): boolean {
	try {
		const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
		if (!Number.isInteger(pid)) return false;
		process.kill(pid, 0); // signal 0 — throws if the process is gone
		return true;
	} catch {
		return false;
	}
}

/**
 * If `telegram.enabled` is true and the gateway is not already running, spawn
 * it in the background. Never throws — failures are logged as warnings so the
 * main skc session is unaffected.
 */
export async function maybeAutostartTelegramRemote(): Promise<void> {
	if (!settings.get("telegram.enabled")) return;

	const config = readTelegramSettings();
	const errors = validateTelegramSettings(config);
	if (errors.length > 0) {
		logger.warn("Telegram Remote enabled but misconfigured, skipping autostart", { errors });
		return;
	}

	const configRoot = getConfigRootDir();
	const pidFile = path.join(configRoot, "telegram-remote.pid");
	if (isAlreadyRunning(pidFile)) {
		logger.info("Telegram Remote already running, skipping autostart");
		return;
	}

	const env = telegramSettingsToEnv(config);
	const { cmd, args } = resolveGatewayCommand();
	const logDir = path.join(configRoot, "logs");
	fs.mkdirSync(logDir, { recursive: true });
	const logFd = fs.openSync(path.join(logDir, "telegram-remote.log"), "a");

	try {
		const proc = Bun.spawn([cmd, ...args], {
			env: { ...process.env, ...env },
			stdio: ["ignore", logFd, logFd],
			detached: true,
		});
		proc.unref();
		fs.writeFileSync(pidFile, String(proc.pid));
		logger.info("Telegram Remote gateway auto-started", { pid: proc.pid });
	} catch (err) {
		logger.warn("Failed to auto-start Telegram Remote gateway", { error: String(err) });
	}
}
