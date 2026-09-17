/**
 * `skc auth-gateway` must work on a single machine without `skc auth-broker serve`.
 *
 * Broker configuration still wins (and must never silently degrade to local
 * credentials), but with no broker configured the gateway now serves from the
 * local SQLite store — the same precedence `discoverAuthStorage()` uses.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, getConfigRootDir, setAgentDir } from "@sayknow-cli/utils";
import { openGatewayCredentialSource, runAuthGatewayCommand } from "../src/cli/auth-gateway-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

describe("auth-gateway local credential fallback", () => {
	let configRoot = "";
	let agentDir = "";
	let originalAgentDir: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalConfigDir: string | undefined;
	let originalPiConfigDir: string | undefined;
	let originalBrokerUrl: string | undefined;
	let originalBrokerToken: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.SKC_CODING_AGENT_DIR;
		originalConfigDir = process.env.SKC_CONFIG_DIR;
		originalPiConfigDir = process.env.PI_CONFIG_DIR;
		originalBrokerUrl = process.env.SKC_AUTH_BROKER_URL;
		originalBrokerToken = process.env.SKC_AUTH_BROKER_TOKEN;
		// Bun's `os.homedir()` ignores a mutated $HOME, so the config root (which
		// holds `auth-gateway.token`) can only be isolated through SKC_CONFIG_DIR:
		// a unique directory name under the real home. Without this the suite reads
		// — and `status`-with-token overwrites — the developer's real
		// ~/.skc/auth-gateway.token.
		const configDirName = `.skc-test-auth-gateway-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
		process.env.SKC_CONFIG_DIR = configDirName;
		delete process.env.PI_CONFIG_DIR;
		configRoot = path.join(os.homedir(), configDirName);
		agentDir = path.join(configRoot, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		delete process.env.SKC_AUTH_BROKER_URL;
		delete process.env.SKC_AUTH_BROKER_TOKEN;
		// Rebuilds the dir resolver against the isolated config root.
		setAgentDir(agentDir);
		if (getConfigRootDir() !== configRoot) {
			throw new Error(`config root not isolated: ${getConfigRootDir()} !== ${configRoot}`);
		}
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.exitCode = 0;
		if (originalConfigDir === undefined) delete process.env.SKC_CONFIG_DIR;
		else process.env.SKC_CONFIG_DIR = originalConfigDir;
		if (originalPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalPiConfigDir;
		if (originalBrokerUrl === undefined) delete process.env.SKC_AUTH_BROKER_URL;
		else process.env.SKC_AUTH_BROKER_URL = originalBrokerUrl;
		if (originalBrokerToken === undefined) delete process.env.SKC_AUTH_BROKER_TOKEN;
		else process.env.SKC_AUTH_BROKER_TOKEN = originalBrokerToken;
		if (originalAgentDir) setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) delete process.env.SKC_CODING_AGENT_DIR;
		else process.env.SKC_CODING_AGENT_DIR = originalAgentDirEnv;
		// Guard against ever deleting a real config root.
		if (configRoot.includes(".skc-test-auth-gateway-")) {
			await fs.rm(configRoot, { recursive: true, force: true });
		}
	});

	test("opens the local SQLite store when no broker is configured", async () => {
		const source = await openGatewayCredentialSource();
		try {
			expect(source.kind).toBe("local");
			expect(source.brokerUrl).toBeNull();
			expect(source.dbPath).toBe(getAgentDbPath(agentDir));
			expect(source.label).toBe(`local ${getAgentDbPath(agentDir)}`);
			expect(source.storage.exportSnapshot().credentials).toEqual([]);
		} finally {
			source.storage.close();
		}
		expect(await Bun.file(getAgentDbPath(agentDir)).exists()).toBe(true);
	});

	test("a configured broker still wins and never degrades to local credentials", async () => {
		// Port 1 is reserved and unbindable, so the client connect fails fast.
		process.env.SKC_AUTH_BROKER_URL = "http://127.0.0.1:1";
		process.env.SKC_AUTH_BROKER_TOKEN = "broker-token";
		let source: Awaited<ReturnType<typeof openGatewayCredentialSource>> | null = null;
		try {
			source = await openGatewayCredentialSource();
		} catch {
			// expected: unreachable broker surfaces as an error
		}
		if (source) {
			const kind = source.kind;
			source.storage.close();
			expect(kind).toBe("broker");
			throw new Error("unreachable broker resolved a credential source");
		}
		expect(source).toBeNull();
	});

	test("status reports the local source and blames the missing token", async () => {
		const read = captureStdout();
		await runAuthGatewayCommand({ action: "status", flags: { json: true } });
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		const status = JSON.parse(read());
		expect(status.source).toBe("local");
		expect(status.ready).toBe(false);
		expect(status.reason).toBe("token_missing");
		expect(status.brokerConfigured).toBe(false);
		expect(status.broker).toBeNull();
		expect(status.dbPath).toBe(getAgentDbPath(agentDir));
		expect(status.credentialCount).toBe(0);
		expect(process.exitCode).toBe(1);
	});

	test("status with a token but an empty local store reports no_credentials", async () => {
		await fs.writeFile(path.join(getConfigRootDir(), "auth-gateway.token"), "gw-token\n", { mode: 0o600 });
		const read = captureStdout();
		await runAuthGatewayCommand({ action: "status", flags: { json: true } });
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		const status = JSON.parse(read());
		expect(status.source).toBe("local");
		expect(status.tokenPresent).toBe(true);
		expect(status.ready).toBe(false);
		expect(status.reason).toBe("no_credentials");
		expect(process.exitCode).toBe(1);
	});

	test("check probes the local store instead of demanding a broker", async () => {
		const read = captureStdout();
		await runAuthGatewayCommand({ action: "check", flags: { json: true } });
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		const report = JSON.parse(read());
		expect(report.source).toBe("local");
		expect(report.broker).toBeNull();
		expect(report.dbPath).toBe(getAgentDbPath(agentDir));
		expect(report.credentials).toEqual([]);
	});
});
