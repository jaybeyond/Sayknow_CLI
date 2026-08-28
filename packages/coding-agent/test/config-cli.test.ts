import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@sayknow-cli/utils";
import { YAML } from "bun";
import { inspectConfigFile, runConfigCommand } from "../src/cli/config-cli";
import { AtomicYamlTestHooks } from "../src/config/atomic-yaml-patch";
import { resetSettingsForTest, Settings } from "../src/config/settings";

let testAgentDir = "";
const originalAgentDir = process.env.SKC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	resetSettingsForTest();
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-config-cli-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	AtomicYamlTestHooks.afterTargetBound = undefined;
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.SKC_CODING_AGENT_DIR;
	}
	await fs.rm(testAgentDir, { recursive: true, force: true });
});

describe("config CLI schema coverage", () => {
	it("renders record settings as JSON and with record type in text output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "list", flags: {} });

		const lines = logSpy.mock.calls.map(call => String(call[0] ?? ""));
		const plainLines = lines.map(line => Bun.stripANSI(line));
		const modelRolesLine = plainLines.find(line => line.includes("modelRoles ="));
		expect(modelRolesLine).toBeDefined();
		const plainModelRolesLine = String(modelRolesLine);
		expect(plainModelRolesLine).toContain("modelRoles =");
		expect(plainModelRolesLine).toContain("(record)");
		expect(plainModelRolesLine).toContain("{");
		expect(plainModelRolesLine).toContain("}");
		expect(plainModelRolesLine).not.toContain("[object Object]");
	});

	it("sets and gets record settings as JSON objects", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const recordValue = '{"default":"claude-opus-4-6"}';

		await runConfigCommand({ action: "set", key: "modelRoles", value: recordValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("modelRoles");
		expect(parsed.type).toBe("record");
		expect(parsed.value).toEqual({ default: "claude-opus-4-6" });
	});

	it("sets and gets array settings as JSON arrays", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const arrayValue = '["claude-opus-4-6","gpt-5.3-codex"]';

		await runConfigCommand({ action: "set", key: "enabledModels", value: arrayValue, flags: { json: true } });
		await runConfigCommand({ action: "get", key: "enabledModels", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		const parsed = JSON.parse(String(payload)) as { key: string; value: unknown; type: string };
		expect(parsed.key).toBe("enabledModels");
		expect(parsed.type).toBe("array");
		expect(parsed.value).toEqual(["claude-opus-4-6", "gpt-5.3-codex"]);
	});

	it("sets and gets deep-interview ambiguity threshold", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({
			action: "set",
			key: "skc.deepInterview.ambiguityThreshold",
			value: "0.2",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "skc.deepInterview.ambiguityThreshold", flags: { json: true } });

		const payload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof payload).toBe("string");
		expect(JSON.parse(String(payload))).toMatchObject({
			key: "skc.deepInterview.ambiguityThreshold",
			type: "number",
			value: 0.2,
		});
	});
	it("sets numeric idle compaction settings from CLI values", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleThresholdTokens",
			value: "300000",
			flags: { json: true },
		});
		await runConfigCommand({
			action: "set",
			key: "compaction.idleTimeoutSeconds",
			value: "600",
			flags: { json: true },
		});
		await runConfigCommand({ action: "get", key: "compaction.idleThresholdTokens", flags: { json: true } });
		await runConfigCommand({ action: "get", key: "compaction.idleTimeoutSeconds", flags: { json: true } });

		const thresholdPayload = logSpy.mock.calls.at(-2)?.[0];
		const timeoutPayload = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof thresholdPayload).toBe("string");
		expect(typeof timeoutPayload).toBe("string");
		expect(JSON.parse(String(thresholdPayload))).toMatchObject({
			key: "compaction.idleThresholdTokens",
			type: "number",
			value: 300000,
		});
		expect(JSON.parse(String(timeoutPayload))).toMatchObject({
			key: "compaction.idleTimeoutSeconds",
			type: "number",
			value: 600,
		});
	});

	it("reports invalid settings through config doctor JSON", async () => {
		await Bun.write(
			path.join(testAgentDir, "config.yml"),
			"configSchemaVersion: 1\nnotifications:\n  enabled: invalid\n",
		);
		resetSettingsForTest();
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runConfigCommand({ action: "doctor", flags: { json: true } });

		const report = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
			issues: Array<{ path: string; kind: string; detail: string }>;
		};
		expect(report.issues).toContainEqual({
			path: "notifications.enabled",
			kind: "invalid",
			detail: "Expected boolean.",
		});
	});

	describe("secret redaction", () => {
		it("redacts secret-like values in list, get, and set output by default", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const brokerSecret = "broker-token-secret-123";
			const apiSecret = "hindsight-api-token-secret-123";

			await runConfigCommand({
				action: "set",
				key: "auth.broker.token",
				value: brokerSecret,
				flags: { json: true },
			});
			await runConfigCommand({ action: "set", key: "hindsight.apiToken", value: apiSecret, flags: { json: true } });
			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true } });
			await runConfigCommand({ action: "list", flags: { json: true } });

			const setPayload = JSON.parse(String(logSpy.mock.calls.at(-4)?.[0])) as { value: unknown };
			const apiTokenSetPayload = JSON.parse(String(logSpy.mock.calls.at(-3)?.[0])) as { value: unknown };
			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(setPayload.value).toBe("<redacted>");
			expect(apiTokenSetPayload.value).toBe("<redacted>");
			expect(getPayload.value).toBe("<redacted>");
			expect(listPayload["auth.broker.token"]?.value).toBe("<redacted>");
			expect(listPayload["hindsight.apiToken"]?.value).toBe("<redacted>");
			expect(JSON.stringify(setPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(apiTokenSetPayload)).not.toContain(apiSecret);
			expect(JSON.stringify(getPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(listPayload)).not.toContain(brokerSecret);
			expect(JSON.stringify(listPayload)).not.toContain(apiSecret);
		});

		it("redacts non-string secret-like values from get and list JSON loaded from config", async () => {
			const configPath = path.join(testAgentDir, "config.yml");
			await Bun.write(
				configPath,
				[
					"auth:",
					"  broker:",
					"    token:",
					"      - broker-token-object-secret-123",
					"hindsight:",
					"  apiToken:",
					"    nested: hindsight-api-token-object-secret-123",
					"",
				].join("\n"),
			);
			resetSettingsForTest();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true } });
			await runConfigCommand({ action: "list", flags: { json: true } });

			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(getPayload.value).toBe("<redacted>");
			expect(listPayload["auth.broker.token"]?.value).toBe("<redacted>");
			expect(listPayload["hindsight.apiToken"]?.value).toBe("<redacted>");
			expect(JSON.stringify(getPayload)).not.toContain("broker-token-object-secret-123");
			expect(JSON.stringify(listPayload)).not.toContain("broker-token-object-secret-123");
			expect(JSON.stringify(listPayload)).not.toContain("hindsight-api-token-object-secret-123");
		});

		it("shows non-string secret-like values with the explicit unsafe opt-in", async () => {
			const configPath = path.join(testAgentDir, "config.yml");
			await Bun.write(
				configPath,
				[
					"auth:",
					"  broker:",
					"    token:",
					"      - broker-token-array-secret-456",
					"hindsight:",
					"  apiToken:",
					"    nested: hindsight-api-token-object-secret-456",
					"",
				].join("\n"),
			);
			resetSettingsForTest();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true, showSecrets: true } });
			await runConfigCommand({ action: "list", flags: { json: true, showSecrets: true } });

			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const listPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, { value: unknown }>;

			expect(getPayload.value).toEqual(["broker-token-array-secret-456"]);
			expect(listPayload["auth.broker.token"]?.value).toEqual(["broker-token-array-secret-456"]);
			expect(listPayload["hindsight.apiToken"]?.value).toEqual({ nested: "hindsight-api-token-object-secret-456" });
		});

		it("keeps non-secret booleans visible while redacting secret-shaped keys in text output", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const secret = "telegram-token-secret-456";

			await runConfigCommand({
				action: "set",
				key: "notifications.telegram.botToken",
				value: secret,
				flags: { json: true },
			});
			await runConfigCommand({ action: "set", key: "notifications.enabled", value: "true", flags: { json: true } });
			await runConfigCommand({ action: "get", key: "notifications.enabled", flags: {} });
			const enabledGet = Bun.stripANSI(String(logSpy.mock.calls.at(-1)?.[0]));
			await runConfigCommand({ action: "list", flags: {} });

			const listOutput = logSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");

			expect(enabledGet).toBe("true");
			expect(listOutput).toContain("notifications.enabled = true");
			expect(listOutput).toContain("notifications.telegram.botToken = <redacted>");
			expect(listOutput).not.toContain(secret);
		});

		it("shows secret-like values only with the explicit unsafe opt-in", async () => {
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const secret = "broker-token-secret-789";

			await runConfigCommand({
				action: "set",
				key: "auth.broker.token",
				value: secret,
				flags: { json: true, showSecrets: true },
			});
			await runConfigCommand({ action: "get", key: "auth.broker.token", flags: { json: true, showSecrets: true } });

			const setPayload = JSON.parse(String(logSpy.mock.calls.at(-2)?.[0])) as { value: unknown };
			const getPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as { value: unknown };

			expect(setPayload.value).toBe(secret);
			expect(getPayload.value).toBe(secret);
		});
	});
});

describe("config doctor", () => {
	it("reports typoed settings from a fixture config", async () => {
		const configPath = path.join(testAgentDir, "config.yml");
		await fs.writeFile(configPath, "compaction:\n  enabled: true\n  enabld: false\n");
		const report = await inspectConfigFile(configPath);
		expect(report.unknownKeys).toContain("compaction.enabld");
	});
});

it("redacts invalid secret settings in doctor output", async () => {
	const configPath = path.join(testAgentDir, "config.yml");
	const secret = "doctor-secret-token";
	await fs.writeFile(configPath, `notifications:\n  telegram:\n    botToken: [${secret}]\n`);

	const report = await inspectConfigFile(configPath);
	expect(report.invalidValues).toContainEqual({ path: "notifications.telegram.botToken", value: "<redacted>" });
	expect(JSON.stringify(report)).not.toContain(secret);
});

describe("config CLI durable persistence", () => {
	it("writes set and reset values before reporting success", async () => {
		const durableValuesAtSuccess: unknown[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {
			const persisted = YAML.parse(readFileSync(path.join(testAgentDir, "config.yml"), "utf8")) as {
				colorBlindMode?: unknown;
			};
			durableValuesAtSuccess.push(persisted.colorBlindMode);
		});

		await runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } });
		expect(durableValuesAtSuccess.at(-1)).toBe(true);

		logSpy.mockClear();
		durableValuesAtSuccess.length = 0;
		await runConfigCommand({ action: "reset", key: "colorBlindMode", flags: { json: true } });
		expect(durableValuesAtSuccess.at(-1)).toBe(false);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			key: "colorBlindMode",
			value: false,
		});
	});

	it("fails without success output or unsafe error details when persistence fails", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);
		const secret = "do-not-print-this-secret";
		const instance = await Settings.init();
		const flushSpy = vi
			.spyOn(instance, "flushOrThrow")
			.mockRejectedValue(new Error(`${testAgentDir}/config.yml ${secret}`));

		try {
			await expect(
				runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } }),
			).rejects.toThrow("process.exit");
		} finally {
			flushSpy.mockRestore();
			await instance.flush();
		}

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logSpy).not.toHaveBeenCalled();
		const diagnostic = errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
		expect(diagnostic).toContain("Failed to persist configuration");
		expect(diagnostic).not.toContain(testAgentDir);
		expect(diagnostic).not.toContain(secret);
	});

	it("fails reset without success output when persistence fails", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({ action: "set", key: "colorBlindMode", value: "true", flags: { json: true } });
		logSpy.mockClear();

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);
		const instance = await Settings.init();
		const secret = `${testAgentDir}/config.yml reset-secret`;
		const flushSpy = vi.spyOn(instance, "flushOrThrow").mockRejectedValue(new Error(secret));
		try {
			await expect(
				runConfigCommand({ action: "reset", key: "colorBlindMode", flags: { json: true } }),
			).rejects.toThrow("process.exit");
		} finally {
			flushSpy.mockRestore();
			await instance.flush();
		}

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n")).toContain(
			"Failed to persist configuration",
		);
		expect(errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n")).not.toContain(secret);
	});

	it("does not rebase a best-effort flush after target retargeting", async () => {
		const configPath = path.join(testAgentDir, "config.yml");
		const realTarget = path.join(testAgentDir, "real-config.yml");
		const otherTarget = path.join(testAgentDir, "other-config.yml");
		const initialReal = { configSchemaVersion: 1, colorBlindMode: false };
		const initialOther = { configSchemaVersion: 1, colorBlindMode: false, other: true };
		await fs.writeFile(realTarget, YAML.stringify(initialReal, null, 2));
		await fs.writeFile(otherTarget, YAML.stringify(initialOther, null, 2));
		await fs.symlink(realTarget, configPath);
		const instance = await Settings.init();
		let retargeted = false;
		AtomicYamlTestHooks.afterTargetBound = async canonicalPath => {
			if (retargeted || canonicalPath !== path.resolve(configPath)) return;
			retargeted = true;
			await fs.rm(configPath, { force: true });
			await fs.symlink(otherTarget, configPath);
		};

		instance.set("colorBlindMode", true);
		await instance.flush();

		expect(retargeted).toBe(true);
		expect(YAML.parse(await fs.readFile(realTarget, "utf8"))).toEqual(initialReal);
		expect(YAML.parse(await fs.readFile(otherTarget, "utf8"))).toEqual(initialOther);

		AtomicYamlTestHooks.afterTargetBound = undefined;
		await fs.rm(configPath, { force: true });
		await fs.symlink(realTarget, configPath);
		await instance.flush();

		expect(YAML.parse(await fs.readFile(realTarget, "utf8"))).toMatchObject({
			configSchemaVersion: 1,
			colorBlindMode: true,
		});
		expect(YAML.parse(await fs.readFile(otherTarget, "utf8"))).toEqual(initialOther);
	});
	it("does not echo an invalid value in diagnostics", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
			throw new Error("process.exit");
		}) as never);
		const secret = "invalid-secret-value".repeat(100);

		await expect(
			runConfigCommand({ action: "set", key: "colorBlindMode", value: secret, flags: { json: true } }),
		).rejects.toThrow("process.exit");

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logSpy).not.toHaveBeenCalled();
		const diagnostic = errorSpy.mock.calls.map(call => Bun.stripANSI(String(call[0] ?? ""))).join("\n");
		expect(diagnostic).toContain("Invalid boolean value");
		expect(diagnostic).not.toContain(secret);
		expect(diagnostic.length).toBeLessThan(256);
	});
});
