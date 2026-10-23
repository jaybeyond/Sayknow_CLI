/**
 * Project MCP sources are untrusted for every provider. Providers outside
 * native and mcp-json must drop `!` shell values before a server is spawned,
 * and must not copy sensitive host names into that child's env.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "../../src/capability/types";
import { clearConfigValueCache } from "../../src/config/resolve-config-value";
import { isSensitiveEnvName } from "../../src/discovery/helpers";
import { MCPManager, omitUnapprovedProjectStdio } from "../../src/runtime-mcp/manager";
import {
	decideUntrustedProjectConfigValue,
	isUntrustedProjectMcpSource,
} from "../../src/runtime-mcp/project-host-values";
import type { MCPServerConfig } from "../../src/runtime-mcp/types";

const SECRET_NAME = "SKC_CANARY_SECRET";
const SECRET = "canary-secret-value";
const BANG_TEXT = "outside-provider-bang";
const HOST_KEY = "OPENAI_API_KEY";
const HOST_VALUE = "host-openai-key";

function source(provider: string, level: SourceMeta["level"]): SourceMeta {
	return { provider, providerName: provider, path: `${provider}.json`, level };
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await Bun.sleep(20);
	}
	return check();
}

describe("project MCP providers outside the historical set", () => {
	const tempDirs: string[] = [];
	let restoreEnv: Array<() => void> = [];

	beforeEach(() => {
		restoreEnv = [SECRET_NAME, HOST_KEY].map(name => {
			const previous = process.env[name];
			return () => {
				if (previous === undefined) delete process.env[name];
				else process.env[name] = previous;
			};
		});
	});

	afterEach(() => {
		for (const restore of restoreEnv) restore();
		clearConfigValueCache();
		for (const dir of tempDirs.splice(0)) void fs.rm(dir, { recursive: true, force: true });
		MCPManager.resetForTests();
	});

	async function tempDir(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-provider-"));
		tempDirs.push(dir);
		return dir;
	}

	async function childReport(
		dir: string,
		level: SourceMeta["level"],
		provider: string,
	): Promise<Record<string, string | null>> {
		const reportPath = path.join(dir, `${provider}-report.json`);
		const scriptPath = path.join(dir, `${provider}-report.mjs`);
		const bangScript = path.join(dir, `${provider}-bang.mjs`);
		await fs.writeFile(bangScript, `process.stdout.write(${JSON.stringify(BANG_TEXT)});\n`);
		await fs.writeFile(
			scriptPath,
			[
				"import fs from 'node:fs';",
				"fs.writeFileSync(process.env.REPORT, JSON.stringify({",
				"  BANG: process.env.BANG ?? null,",
				"  PUBLIC: process.env.PUBLIC ?? null,",
				"  LEAK: process.env.LEAK ?? null,",
				"  HOST: process.env.OPENAI_API_KEY ?? null,",
				"}));",
				"process.exit(0);",
				"",
			].join("\n"),
		);
		const config: MCPServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [scriptPath],
			timeout: 3000,
			env: {
				REPORT: reportPath,
				BANG: `!"${process.execPath}" "${bangScript}"`,
				PUBLIC: "plain-ok",
				LEAK: SECRET_NAME,
			},
		};
		process.env[SECRET_NAME] = SECRET;
		process.env[HOST_KEY] = HOST_VALUE;
		const manager = new MCPManager(dir, null, {});
		try {
			await manager.connectServers({ server: config }, { server: source(provider, level) });
			expect(await waitUntil(async () => exists(reportPath), 4000)).toBe(true);
			return JSON.parse(await fs.readFile(reportPath, "utf8")) as Record<string, string | null>;
		} finally {
			await manager.disconnectAll().catch(() => {});
		}
	}

	it("drops ! shell values for a project provider outside native and mcp-json and keeps them out of the child", async () => {
		const dir = await tempDir();
		for (const provider of ["claude-plugins", "skc-plugins"]) {
			clearConfigValueCache();
			const report = await childReport(dir, "project", provider);
			expect(report.BANG).toBeNull();
			expect(report.PUBLIC).toBe("plain-ok");
			expect(report.LEAK).toBe(SECRET_NAME);
			expect(report.LEAK).not.toBe(SECRET);
			expect(report.HOST).toBeNull();
			expect(JSON.stringify(report)).not.toContain(SECRET);
			expect(JSON.stringify(report)).not.toContain(BANG_TEXT);
			expect(JSON.stringify(report)).not.toContain(HOST_VALUE);
		}
	}, 20_000);

	it("still runs ! and keeps host credentials for a user-level provider outside that set", async () => {
		const dir = await tempDir();
		const report = await childReport(dir, "user", "claude-plugins");
		expect(report.BANG).toBe(BANG_TEXT);
		expect(report.PUBLIC).toBe("plain-ok");
		expect(report.LEAK).toBe(SECRET);
		expect(report.HOST).toBe(HOST_VALUE);
	}, 20_000);

	it("drops unapproved project stdio from a provider outside the historical set", () => {
		const configs = {
			plugin: { type: "stdio", command: "plugin", args: [] } as MCPServerConfig,
			remote: { type: "http", url: "http://127.0.0.1:9/mcp" } as MCPServerConfig,
		};
		omitUnapprovedProjectStdio(
			configs,
			{
				plugin: source("claude-plugins", "project"),
				remote: source("skc-plugins", "project"),
			},
			false,
		);
		expect(configs.plugin).toBeUndefined();
		expect(configs.remote?.type).toBe("http");
	});

	it("still keeps approved project stdio, http servers, user stdio, and tools-only loads", () => {
		const stdio = (name: string): MCPServerConfig => ({ type: "stdio", command: name, args: [] });
		const http: MCPServerConfig = { type: "http", url: "http://127.0.0.1:9/mcp" };
		const approved = {
			plugin: stdio("plugin"),
			remote: http,
			user: stdio("user"),
		};
		omitUnapprovedProjectStdio(
			approved,
			{
				plugin: source("claude-plugins", "project"),
				remote: source("skc-plugins", "project"),
				user: source("claude-plugins", "user"),
			},
			true,
		);
		expect(approved.plugin?.type).toBe("stdio");
		expect(approved.remote?.type).toBe("http");
		expect(approved.user?.type).toBe("stdio");
		const toolsOnly = { tools: stdio("tools") };
		omitUnapprovedProjectStdio(toolsOnly, { tools: source("claude-plugins", "project") }, false, true);
		expect(toolsOnly.tools?.type).toBe("stdio");
	});

	it("property project provider trust seed 20261022", () => {
		// Seeded xorshift32 replaces upstream's fast-check property (same seed and run count).
		let state = 20261022 >>> 0;
		const next = (): number => {
			state ^= state << 13;
			state >>>= 0;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			return state;
		};
		const pick = <T>(items: readonly T[]): T => items[next() % items.length]!;
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-!$ ";
		const randomString = (maxLength: number): string => {
			let out = "";
			const length = next() % (maxLength + 1);
			for (let i = 0; i < length; i++) out += alphabet[next() % alphabet.length];
			return out;
		};
		const sensitiveSamples = ["OPENAI_API_KEY", "SKC_CANARY_SECRET", "GITHUB_TOKEN", "!echo hi", "!", "plain"];
		for (let run = 0; run < 80; run++) {
			const name =
				next() % 2 === 0
					? pick(["native", "mcp-json", "claude-plugins", "skc-plugins"] as const)
					: randomString(24);
			const level = pick(["user", "project", "native"] as const);
			const toolsOnly = next() % 2 === 0;
			const value = next() % 3 === 0 ? pick(sensitiveSamples) : randomString(48);
			const missing = next() % 2 === 0;
			const meta = missing ? undefined : source(name, level as SourceMeta["level"]);
			const untrusted = isUntrustedProjectMcpSource(meta, toolsOnly);
			expect(isUntrustedProjectMcpSource(meta, toolsOnly)).toBe(untrusted);
			expect(untrusted).toBe(!missing && !toolsOnly && level === "project");
			const decision = decideUntrustedProjectConfigValue(value, untrusted);
			expect(decideUntrustedProjectConfigValue(value, untrusted)).toEqual(decision);
			if (!untrusted) {
				expect(decision).toEqual({ action: "resolve" });
				continue;
			}
			if (value.startsWith("!")) {
				expect(decision).toEqual({ action: "drop" });
				continue;
			}
			if (isSensitiveEnvName(value)) {
				expect(decision).toEqual({ action: "literal", value });
				continue;
			}
			expect(decision).toEqual({ action: "resolve" });
		}
	});
});
