/**
 * Tests for the per-run completion-notification opt-out `SKC_NOTIFY=off`.
 *
 * Non-interactive fleet runs (`skc -p --no-session`) inherit the global
 * `completion.notify=on` / `completion.notifyCommand` and therefore fire a
 * notification per run (e.g. a command that opens a fresh Telegram topic). The env
 * var gives those runs a config-untouched, child-inheritable way to stay silent —
 * honored before any settings lookup in `sendCompletionNotification`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@sayknow-cli/ai";
import { resetSettingsForTest, Settings, settings } from "@sayknow-cli/coding-agent/config/settings";
import { EventController } from "@sayknow-cli/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@sayknow-cli/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@sayknow-cli/coding-agent/modes/types";
import { completionNotifyDisabledByEnv } from "@sayknow-cli/coding-agent/sdk/bus/config";
import { TERMINAL } from "@sayknow-cli/tui";

type NotifyProc = Bun.Subprocess<"ignore", "ignore", "ignore">;

beforeAll(() => {
	initTheme();
});

const ORIGINAL_SKC_NOTIFY = process.env.SKC_NOTIFY;

beforeEach(async () => {
	resetSettingsForTest();
	delete process.env.SKC_NOTIFY;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-notify-env-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (ORIGINAL_SKC_NOTIFY === undefined) delete process.env.SKC_NOTIFY;
	else process.env.SKC_NOTIFY = ORIGINAL_SKC_NOTIFY;
});

function makeAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason: "stop",
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeContext(): InteractiveModeContext {
	return {
		isBackgrounded: true,
		sessionManager: {
			getSessionName: () => "test-session",
			getCwd: () => process.cwd(),
			getSessionId: () => "session-test",
		},
		session: {
			getLastAssistantMessage: () => makeAssistantMessage(),
		},
	} as unknown as InteractiveModeContext;
}

describe("completionNotifyDisabledByEnv", () => {
	it("is true for off / 0 / false, case- and whitespace-insensitive", () => {
		for (const v of ["off", "OFF", "0", "false", "False", "  off  "]) {
			expect(completionNotifyDisabledByEnv({ SKC_NOTIFY: v })).toBe(true);
		}
	});

	it("is false when unset, empty, or any on-ish value", () => {
		expect(completionNotifyDisabledByEnv({})).toBe(false);
		expect(completionNotifyDisabledByEnv({ SKC_NOTIFY: "" })).toBe(false);
		for (const v of ["on", "1", "true", "yes"]) {
			expect(completionNotifyDisabledByEnv({ SKC_NOTIFY: v })).toBe(false);
		}
	});

	it("does not read the sibling SKC_NOTIFICATIONS var", () => {
		expect(completionNotifyDisabledByEnv({ SKC_NOTIFICATIONS: "0" })).toBe(false);
	});
});

describe("sendCompletionNotification — SKC_NOTIFY=off per-run opt-out", () => {
	it("suppresses every surface even with completion.notify=on and a notifyCommand set", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const spawnSpy = vi
			.spyOn(Bun, "spawn")
			.mockImplementation(
				() => ({ exited: Promise.resolve(0), kill: () => {}, unref: () => {} }) as unknown as NotifyProc,
			);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		settings.override("completion.notify", "on");
		settings.set("completion.notifyCommand", "notify-test");
		settings.set("notifications.terminalBell", true);
		settings.set("notifications.bellOnComplete", true);
		process.env.SKC_NOTIFY = "off";

		new EventController(makeContext()).sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(0);
		expect(spawnSpy).toHaveBeenCalledTimes(0);
		expect(writeSpy).not.toHaveBeenCalledWith("\x07");
	});

	it("still fires normally when SKC_NOTIFY is unset (control)", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		// beforeEach already deleted SKC_NOTIFY.

		new EventController(makeContext()).sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(1);
	});

	it("still fires when SKC_NOTIFY is an on-ish value", () => {
		const terminalSpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		settings.override("completion.notify", "on");
		process.env.SKC_NOTIFY = "on";

		new EventController(makeContext()).sendCompletionNotification();

		expect(terminalSpy).toHaveBeenCalledTimes(1);
	});
});
