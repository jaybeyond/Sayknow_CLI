/**
 * Red-team / adversarial tests for `skc migrate`. These try to break the feature:
 * secret leakage, path traversal, all-malformed input, and cross-source collisions.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runMigrate } from "../src/cli/migrate-cli";

let home: string;
let cwd: string;

async function write(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-redteam-home-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-redteam-cwd-"));
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

const base = (over: Partial<Parameters<typeof runMigrate>[0]>) => ({
	from: ["all"] as string[],
	project: true,
	force: false,
	dryRun: false,
	json: true,
	homeDir: home,
	cwd,
	...over,
});

describe("red-team: secret leakage", () => {
	test("codex env_vars / bearer_token values never appear in the report", async () => {
		await write(
			".codex/config.toml",
			'[mcp_servers.srv]\ncommand = "bin"\nbearer_token_env_var = "TOKEN_ENV"\n\n[mcp_servers.srv.env_vars]\nSECRET = "TOPSECRET-LEAK-CANARY"\n',
		);
		const report = await runMigrate(base({ from: ["codex"], dryRun: true }));
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("TOPSECRET-LEAK-CANARY");
		// The field name may be referenced in a warning, but never the value.
		expect(serialized.includes("env_vars") || serialized.includes("bearer_token_env_var")).toBe(true);
	});
});

describe("red-team: path traversal", () => {
	test("a malicious skill name cannot escape the skills dir", async () => {
		await write(".claude/skills/..evil/SKILL.md", "---\ndescription: x\n---\nbody");
		await runMigrate(base({ from: ["claude-code"] }));
		// Slugified to a safe name; nothing written outside the project skills dir.
		const escaped = path.join(cwd, "evil");
		const escaped2 = path.join(path.dirname(cwd), "evil");
		expect(await exists(escaped)).toBe(false);
		expect(await exists(escaped2)).toBe(false);
		const skillsDir = path.join(cwd, ".skc", "skills");
		const entries = await fs.readdir(skillsDir).catch(() => []);
		for (const e of entries) expect(e.includes("..")).toBe(false);
	});
});

describe("red-team: all-malformed input", () => {
	test("every source malformed -> ok=false, no partial MCP writes", async () => {
		await write(".claude.json", "{ broken");
		await write(".codex/config.toml", "= = broken ][");
		await write(".config/opencode/opencode.json", "{ broken");
		const report = await runMigrate(base({}));
		expect(report.ok).toBe(false);
		expect(await exists(path.join(cwd, ".skc", "mcp.json"))).toBe(false);
	});
});

describe("red-team: cross-source slug collision", () => {
	test("same skill slug from two sources: first imported, second skipped (no silent clobber)", async () => {
		await write(".claude/skills/shared/SKILL.md", "---\ndescription: from-claude\n---\nbody");
		await write(".config/opencode/skills/shared/SKILL.md", "---\ndescription: from-opencode\n---\nbody");
		const report = await runMigrate(base({ from: ["claude-code", "opencode"] }));
		const skillActions = report.actions.filter(a => a.type === "skill" && a.name === "shared");
		expect(skillActions).toHaveLength(2);
		expect(skillActions[0].status).toBe("imported");
		expect(skillActions[1].status).toBe("skipped_exists");
		// The first (canonical-order: claude-code) wins on disk.
		const written = await fs.readFile(path.join(cwd, ".skc", "skills", "shared", "SKILL.md"), "utf-8");
		expect(written).toContain("from-claude");
	});
});
