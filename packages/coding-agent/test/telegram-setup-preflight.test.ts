import { describe, expect, test } from "bun:test";
import type { Settings } from "../src/config/settings";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { type DaemonState, resolveTelegramSetupPreflight } from "../src/sdk/bus/telegram-daemon";
import { createLightweightDaemonSettings } from "../src/sdk/bus/telegram-daemon-cli";
import { resolveTelegramSetupPollingPolicy } from "../src/sdk/bus/telegram-setup";

const TOKEN = "123456:AAExampleBotTokenForTests";
const CHAT_ID = "555";

function settingsWithChatId(): Settings {
	return createLightweightDaemonSettings({
		agentDir: "/tmp/skc-preflight-test",
		rawConfig: { notifications: { telegram: { chatId: CHAT_ID } } },
	}) as unknown as Settings;
}

function daemonState(overrides: Partial<DaemonState>): DaemonState {
	return {
		pid: 4242,
		incarnation: "linux:111",
		ownerId: `4242-${TOKEN}`,
		tokenFingerprint: tokenFingerprint(TOKEN),
		chatId: CHAT_ID,
		startedAt: 1,
		heartbeatAt: 1,
		roots: [],
		version: 1,
		...overrides,
	} as DaemonState;
}

describe("resolveTelegramSetupPreflight", () => {
	test("returns no daemon when no state file exists", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => undefined,
			pidAlive: () => true,
			pidIncarnation: () => "linux:111",
		});
		expect(preflight).toEqual({ storedChatId: CHAT_ID });
	});

	test("treats a stale state file with a recycled PID as no live daemon", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => daemonState({ incarnation: "linux:111" }),
			// The recycled PID is alive, but it belongs to an unrelated process
			// whose start incarnation no longer matches the persisted daemon.
			pidAlive: () => true,
			pidIncarnation: () => "linux:999",
		});
		expect(preflight.daemon).toBeUndefined();
		expect(preflight.storedChatId).toBe(CHAT_ID);
	});

	test("treats a dead PID as no live daemon", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => daemonState({}),
			pidAlive: () => false,
			pidIncarnation: () => "linux:111",
		});
		expect(preflight.daemon).toBeUndefined();
	});

	test("reports a live daemon only when the incarnation still matches", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => daemonState({ incarnation: "linux:111" }),
			pidAlive: () => true,
			pidIncarnation: () => "linux:111",
		});
		expect(preflight.daemon).toEqual({
			live: true,
			tokenFingerprint: tokenFingerprint(TOKEN),
			chatId: CHAT_ID,
		});
	});

	test("a read failure never fabricates a live daemon", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => {
				throw new Error("state unreadable");
			},
			pidAlive: () => true,
			pidIncarnation: () => "linux:111",
		});
		expect(preflight).toEqual({ storedChatId: CHAT_ID });
	});

	test("the stale-PID preflight yields a discover policy so pairing is not blocked", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => daemonState({ incarnation: "linux:111" }),
			pidAlive: () => true,
			pidIncarnation: () => "linux:999",
		});
		const policy = resolveTelegramSetupPollingPolicy({ token: TOKEN, preflight });
		expect(policy.kind).toBe("discover");
	});

	test("a genuinely live matching daemon reuses the stored chat instead of discovering", async () => {
		const preflight = await resolveTelegramSetupPreflight(settingsWithChatId(), {
			readDaemonState: async () => daemonState({ incarnation: "linux:111" }),
			pidAlive: () => true,
			pidIncarnation: () => "linux:111",
		});
		const policy = resolveTelegramSetupPollingPolicy({ token: TOKEN, preflight });
		expect(policy).toEqual({ kind: "reuse_stored_chat", chatId: CHAT_ID });
	});
});
