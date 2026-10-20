import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	installSkcPluginBundle,
	loadAlwaysOnPluginTools,
	loadConstrainedPluginHooks,
} from "../../src/extensibility/skc-plugins";
import { BUNDLE, cleanupTemps, mkTemp } from "./helpers";

afterEach(cleanupTemps);

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
async function skc(args: string[], env: Record<string, string>, cwd: string) {
	const proc = Bun.spawn({
		cmd: [process.execPath, CLI, ...args],
		cwd,
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("CLI install (AC1)", () => {
	it("installs into a temp user agent dir, lists it enabled, and registers the 7 declared surfaces", async () => {
		const root = await mkTemp("skc-vr-install-");
		const env = { SKC_CODING_AGENT_DIR: path.join(root, "agent"), HOME: path.join(root, "home") };
		const install = await skc(["plugin", "install", BUNDLE, "--user", "--json"], env, root);
		expect(install.exitCode).toBe(0);
		expect(install.stderr).toBe("");
		expect(JSON.parse(install.stdout)).toEqual({ name: "verification-receipts", status: "installed", scope: "user" });
		const list = await skc(["plugin", "list", "--json"], env, root);
		expect(list.exitCode).toBe(0);
		const entry = JSON.parse(list.stdout).skc.find((e: { name: string }) => e.name === "verification-receipts");
		expect(entry).toMatchObject({ version: "0.1.0", scope: "user", enabled: true });
		expect(entry.quarantined ?? false).toBe(false);
		const ids = [...entry.surfaces.tools, ...entry.surfaces.hooks]
			.map((s: { extensionId: string }) => s.extensionId)
			.sort();
		expect(ids).toEqual([
			"hook:tool_call:before:task:verification-gate-baseline",
			"hook:tool_result:after:job:verification-gate-job",
			"hook:tool_result:after:subagent:verification-gate-subagent",
			"hook:tool_result:after:task:verification-gate-task",
			"tool:verification_loop",
			"tool:verification_run",
			"tool:verification_status",
		]);
		const copied = entry.copiedFiles.map((f: { relativePath: string }) => f.relativePath).sort();
		expect(copied).toEqual([
			"hooks/verification-baseline.ts",
			"hooks/verification-gate.ts",
			"sayknow-plugin.json",
			"tools/verification-git.ts",
			"tools/verification-loop.ts",
			"tools/verification-run.ts",
			"tools/verification-status.ts",
		]);
		expect(await fs.readdir(path.join(root, "agent", "skc-plugins", "verification-receipts"))).toEqual(
			expect.arrayContaining(["hooks", "tools", "sayknow-plugin.json"]),
		);
	}, 60_000);
});

async function projectWith(bundle = BUNDLE): Promise<string> {
	const cwd = await mkTemp("skc-vr-proj-");
	await installSkcPluginBundle(bundle, { scope: "project", cwd });
	return cwd;
}

describe("runtime activation (AC2-AC5)", () => {
	it("registers exactly the 3 strict tools and the 4 hook handlers", async () => {
		const cwd = await projectWith();
		const tools = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(tools.quarantine).toEqual([]);
		expect(tools.tools.map(t => t.name).sort()).toEqual([
			"verification_loop",
			"verification_run",
			"verification_status",
		]);
		for (const t of tools.tools) expect((t as { strict?: boolean }).strict).toBe(true);
		const hooks = await loadConstrainedPluginHooks({ cwd });
		expect(hooks.quarantine).toEqual([]);
		expect(hooks.hooks.map(h => `${h.event}:${h.target}:${h.phase}`).sort()).toEqual([
			"tool_call:task:before",
			"tool_result:job:after",
			"tool_result:subagent:after",
			"tool_result:task:after",
		]);
	});

	it("rejects a tool whose manifest name differs from its factory name (AC3)", async () => {
		const src = await mkTemp("skc-vr-mismatch-");
		await fs.cp(BUNDLE, src, { recursive: true });
		const manifest = JSON.parse(await fs.readFile(path.join(src, "sayknow-plugin.json"), "utf8"));
		manifest.tools[1].name = "verification_other";
		await fs.writeFile(path.join(src, "sayknow-plugin.json"), JSON.stringify(manifest));
		const cwd = await projectWith(src);
		const res = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(res.tools.map(t => t.name)).not.toContain("verification_status");
		expect(res.tools.map(t => t.name)).not.toContain("verification_other");
		expect(res.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
	});

	it("quarantines an edited installed file before anything is imported (AC4)", async () => {
		const cwd = await projectWith();
		const installed = path.join(cwd, ".skc", "skc-plugins", "verification-receipts", "tools", "verification-run.ts");
		await fs.appendFile(installed, "\n// tampered\n");
		const tools = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: [] });
		expect(tools.tools).toEqual([]);
		expect(tools.quarantine.some(q => q.code === "runtime_mismatch")).toBe(true);
		const hooks = await loadConstrainedPluginHooks({ cwd });
		expect(hooks.hooks).toEqual([]);
	});

	it("a pre-existing verification_run collides: no tool registers, one session_collision, hooks still load (AC5)", async () => {
		const cwd = await projectWith();
		const tools = await loadAlwaysOnPluginTools({ cwd, reservedToolNames: ["verification_run"] });
		expect(tools.tools).toEqual([]);
		const collisions = tools.quarantine.filter(q => q.code === "session_collision");
		expect(collisions).toHaveLength(1);
		expect(collisions[0]?.surfaceId).toBe("tool:verification_run");
		const hooks = await loadConstrainedPluginHooks({ cwd });
		expect(hooks.hooks).toHaveLength(4);
		expect(hooks.quarantine).toEqual([]);
	});

	it("project-scope installs create nothing but the plugin dir under <repo>/.skc until a tool runs (AC13)", async () => {
		const cwd = await projectWith();
		const entries = (await fs.readdir(path.join(cwd, ".skc"))).sort();
		expect(entries.every(e => e === "skc-plugins" || e === "state")).toBe(true);
		expect(entries).not.toContain("skc-plugin-data");
	});
});

describe("live session with an explicit --tools allowlist", () => {
	it("activates plugin tools named in toolNames instead of quarantining them as self-collisions", async () => {
		const { getBundledModel } = await import("@sayknow-cli/ai");
		const { Settings } = await import("../../src/config/settings");
		const { createAgentSession } = await import("../../src/sdk");
		const { SessionManager } = await import("../../src/session/session-manager");
		const cwd = await projectWith();
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			toolNames: ["read", "verification_run", "verification_status"],
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			const active = session.getActiveToolNames();
			expect(active).toContain("read");
			expect(active).toContain("verification_run");
			expect(active).toContain("verification_status");
		} finally {
			await session.dispose();
		}
	}, 60_000);
});
