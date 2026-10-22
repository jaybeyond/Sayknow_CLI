/**
 * MCP discovery must not spawn a project `.skc/mcp.json` stdio server without
 * caller approval. A user mcp.json server and project HTTP servers still load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@sayknow-cli/utils";
import { clearCache } from "../../src/capability/fs";
import { discoverAndLoadMCPTools, MCPManager } from "../../src/runtime-mcp";

const originalAgentDir = getAgentDir();

function serverScript(marker: string): string {
	return `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(marker)}, '1');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hello', description: 'Demo', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
setInterval(() => {}, 1000);
`;
}

function stdioServer(marker: string) {
	return { type: "stdio", command: process.execPath, args: ["-e", serverScript(marker)], timeout: 5000 };
}

describe("project MCP stdio approval", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let managers: MCPManager[];

	beforeEach(() => {
		MCPManager.resetForTests();
		clearCache();
		managers = [];
		// The exact-config reader refuses symlinked ancestors such as macOS `/var`.
		root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "skc-mcp-stdio-approval-"));
		projectDir = path.join(root, "project");
		agentDir = path.join(root, ".skc", "agent");
		fs.mkdirSync(path.join(projectDir, ".skc"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		setAgentDir(agentDir);
		vi.spyOn(os, "homedir").mockReturnValue(root);
	});

	afterEach(async () => {
		for (const manager of managers) await manager.disconnectAll().catch(() => {});
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		clearCache();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("does not spawn a project stdio server during discovery", async () => {
		const marker = path.join(root, "project-ran");
		fs.writeFileSync(
			path.join(projectDir, ".skc", "mcp.json"),
			JSON.stringify({ mcpServers: { project: stdioServer(marker) } }),
		);
		const result = await discoverAndLoadMCPTools(projectDir);
		managers.push(result.manager);
		expect(result.connectedServers).not.toContain("project");
		expect(fs.existsSync(marker)).toBe(false);
	}, 30_000);

	it("still spawns a user mcp.json stdio server", async () => {
		const marker = path.join(root, "user-ran");
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { user: stdioServer(marker) } }));
		const projectMarker = path.join(root, "project-ran");
		fs.writeFileSync(
			path.join(projectDir, ".skc", "mcp.json"),
			JSON.stringify({ mcpServers: { project: stdioServer(projectMarker) } }),
		);
		const result = await discoverAndLoadMCPTools(projectDir);
		managers.push(result.manager);
		expect(result.connectedServers).toContain("user");
		expect(fs.existsSync(marker)).toBe(true);
		expect(result.connectedServers).not.toContain("project");
		expect(fs.existsSync(projectMarker)).toBe(false);
	}, 30_000);

	it("spawns a project stdio server when the manager was approved for it", async () => {
		const marker = path.join(root, "approved-ran");
		fs.writeFileSync(
			path.join(projectDir, ".skc", "mcp.json"),
			JSON.stringify({ mcpServers: { project: stdioServer(marker) } }),
		);
		const manager = new MCPManager(projectDir, null, { allowUntrustedProjectStdio: true });
		managers.push(manager);
		const result = await manager.discoverAndConnect();
		expect(result.connectedServers).toContain("project");
		expect(fs.existsSync(marker)).toBe(true);
	}, 30_000);
});
