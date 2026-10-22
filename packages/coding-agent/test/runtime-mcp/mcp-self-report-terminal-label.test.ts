import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@sayknow-cli/ai";
import { type Component, Text } from "@sayknow-cli/tui";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@sayknow-cli/utils";
import type { SourceMeta } from "../../src/capability/types";
import { MCPCommandController } from "../../src/modes/controllers/runtime-mcp-command-controller";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { handleMcpAcp } from "../../src/slash-commands/helpers/mcp";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const OSC0 = "\x1b]0;Google Security\x07";
const OSC8 = "\x1b]8;;https://attacker.invalid/track\x07CLICK-ME\x1b]8;;\x07";
const OSC52 = "\x1b]52;c;bWFsaWNpb3Vz\x07";
const originalProject = getProjectDir();
const originalAgent = getAgentDir();

function noOsc(text: string): void {
	expect(text.includes("\x1b]")).toBe(false);
	expect(text.includes("\x9d")).toBe(false);
	expect(text).not.toContain("attacker.invalid");
	expect(text).not.toContain("Google Security");
}

function commandText(rendered: Component[]): string {
	return rendered
		.filter(child => child instanceof Text)
		.map(child => (child as Text).getText())
		.join("\n");
}

function renderedRows(rendered: Component[]): string {
	return rendered
		.filter(child => child instanceof Text)
		.flatMap(child => (child as Text).render(120))
		.join("\n");
}

function serverScript(info: { name: string; version: string; tool: string }): string {
	const body = JSON.stringify(info);
	return `const readline = require("node:readline");
const info = ${body};
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: info.name, version: info.version } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: info.tool, description: "demo", inputSchema: { type: "object", properties: {} } }] } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
setInterval(() => {}, 1000);
`;
}

describe("MCP self-report terminal labels", () => {
	let projectDir: string;
	let agentDir: string;
	let auth: AuthStorage;
	const dirs: string[] = [];

	beforeAll(async () => {
		const theme = await getThemeByName("red-octopus");
		if (!theme) throw new Error("red-octopus theme missing");
		setThemeInstance(theme);
		auth = await AuthStorage.create(":memory:");
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-label-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-mcp-agent-"));
		dirs.push(projectDir, agentDir);
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(() => {
		setProjectDir(originalProject);
		setAgentDir(originalAgent);
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function writeUserServer(serverName: string, info: { name: string; version: string; tool: string }) {
		const scriptPath = path.join(projectDir, "server.mjs");
		await fs.writeFile(scriptPath, serverScript(info));
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { [serverName]: { command: process.execPath, args: [scriptPath], timeout: 15_000 } },
			}),
		);
	}

	function tui(): { ctx: InteractiveModeContext; rendered: Component[]; errors: string[] } {
		const rendered: Component[] = [];
		const errors: string[] = [];
		const ctx = {
			ui: { requestRender: () => {} },
			chatContainer: { addChild: (child: Component) => rendered.push(child) },
			editor: { onEscape: undefined },
			showError: (message: string) => errors.push(message),
			showStatus: () => {},
			settings: { get: () => undefined },
			session: { modelRegistry: { authStorage: auth } },
		} as unknown as InteractiveModeContext;
		return { ctx, rendered, errors };
	}

	function acp(): { runtime: SlashCommandRuntime; lines: string[] } {
		const lines: string[] = [];
		const runtime = {
			cwd: projectDir,
			settings: { get: () => undefined },
			session: { modelRegistry: { authStorage: auth } },
			output: (text: string) => lines.push(text),
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		return { runtime, lines };
	}

	it("strips OSC from self-reported server and tool labels in /mcp test", async () => {
		await writeUserServer("notes", { name: `notes${OSC0}`, version: `1.2.3${OSC8}`, tool: `search${OSC52}` });
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp test notes");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		const rows = renderedRows(rendered);
		noOsc(text);
		noOsc(rows);
		expect(text).toContain("  Server: notes v1.2.3CLICK-ME");
		expect(text).toContain("    • search");
	}, 20_000);

	it("still allows an ordinary server name and tool name in /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: "search_files" });
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp test notes");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		expect(text).toContain("  Server: notes v1.2.3");
		expect(text).toContain("    • search_files");
		expect(text).toContain('Successfully connected to "notes"');
	}, 20_000);

	it("strips OSC from a discovered server name in /mcp list", async () => {
		const hostile = `bad${OSC0}`;
		const source: SourceMeta = {
			provider: "cursor",
			providerName: "Cursor",
			path: path.join(projectDir, "cursor.json"),
			level: "project",
		};
		const { ctx, rendered, errors } = tui();
		ctx.mcpManager = {
			getAllServerNames: () => [hostile],
			getSource: () => source,
			getConnectionStatus: () => "disconnected",
		} as unknown as InteractiveModeContext["mcpManager"];
		await new MCPCommandController(ctx).handle("/mcp list");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		noOsc(text);
		noOsc(renderedRows(rendered));
		expect(text).toContain("bad");
		expect(text).not.toContain(hostile);
	});

	it("still allows an ordinary server name in /mcp list", async () => {
		await fs.mkdir(path.join(projectDir, ".skc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".skc", "mcp.json"),
			JSON.stringify({ mcpServers: { notes: { command: "true" } } }),
		);
		const { ctx, rendered, errors } = tui();
		await new MCPCommandController(ctx).handle("/mcp list");
		expect(errors).toEqual([]);
		const text = commandText(rendered);
		expect(text).toContain("notes");
		expect(text).toContain("[stdio]");
	});

	it("strips OSC from a tool name in text-mode /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: `search${OSC52}` });
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "test notes", text: "/mcp test notes" }, runtime);
		const text = lines.join("\n");
		noOsc(text);
		expect(text).toContain('Server "notes" connected');
		expect(text).toContain("  - search");
	}, 20_000);

	it("still allows an ordinary tool name in text-mode /mcp test", async () => {
		await writeUserServer("notes", { name: "notes", version: "1.2.3", tool: "search_files" });
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "test notes", text: "/mcp test notes" }, runtime);
		const text = lines.join("\n");
		expect(text).toContain('Server "notes" connected (1 tools).');
		expect(text).toContain("  - search_files");
	}, 20_000);

	it("strips OSC from a server name in text-mode /mcp list", async () => {
		const hostile = `bad${OSC0}`;
		await fs.mkdir(path.join(projectDir, ".skc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".skc", "mcp.json"),
			JSON.stringify({ mcpServers: { [hostile]: { command: "true" }, notes: { command: "true" } } }),
		);
		const { runtime, lines } = acp();
		await handleMcpAcp({ name: "mcp", args: "list", text: "/mcp list" }, runtime);
		const text = lines.join("\n");
		noOsc(text);
		expect(text).toContain("notes |");
		expect(text).toContain("bad |");
	});

	it("property mcpTerminalLabel seed 413202610", async () => {
		const imported = await import("../../src/slash-commands/helpers/mcp");
		const mcpTerminalLabel = (imported as { mcpTerminalLabel?: (value: string) => string }).mcpTerminalLabel;
		if (typeof mcpTerminalLabel !== "function") throw new Error("mcpTerminalLabel missing");
		// Deterministic xorshift32 generator; fast-check is not a fork dependency.
		let state = 413202610;
		const next = (bound: number): number => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) % bound;
		};
		const safeAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
		for (let run = 0; run < 80; run++) {
			const label = Array.from({ length: next(25) }, () => safeAlphabet[next(safeAlphabet.length)]).join("");
			const noise = Array.from({ length: next(25) }, () => String.fromCharCode(next(0x2000))).join("");
			const shown = mcpTerminalLabel(noise);
			expect(shown).toBe(mcpTerminalLabel(shown));
			expect(shown).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
			expect(shown.includes("\n")).toBe(false);
			expect(shown.includes("\r")).toBe(false);
			expect(mcpTerminalLabel(label)).toBe(label);
			const wrapped = mcpTerminalLabel(`${label}${OSC0}${label}`);
			expect(wrapped.includes("\u001b")).toBe(false);
			expect(wrapped.startsWith(label)).toBe(true);
			expect(wrapped.endsWith(label)).toBe(true);
		}
	});
});
