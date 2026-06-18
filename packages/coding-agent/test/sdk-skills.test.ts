import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { DEFAULT_SKC_DEFINITION_NAMES } from "@sayknow-cli/coding-agent/defaults/skc-defaults";
import type { Skill } from "@sayknow-cli/coding-agent/sdk";
import { createAgentSession } from "@sayknow-cli/coding-agent/sdk";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function createIsolatedSkillsSettings(): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	});
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `skc-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .skc/skills/ for native project-level discovery.
		skillsDir = path.join(tempDir, ".skc", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".skc", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the native SKC skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(path.dirname(skillsDir), "symlinked-skill-link"), "dir");
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("loads embedded default SKC workflow skills even when .skc is absent and arbitrary skill discovery is disabled", async () => {
		fs.rmSync(path.join(tempDir, ".skc"), { recursive: true, force: true });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "skills.enabled": false }),
		});
		const expected = [...DEFAULT_SKC_DEFINITION_NAMES].sort();

		expect(session.skills.map(skill => skill.name).sort()).toEqual(expected);
		expect(session.skills.every(skill => skill.filePath.startsWith("embedded:skc/skills/"))).toBe(true);
	}, 15_000);

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".skc", "agent");
		fs.rmSync(path.join(userAgentDir, "skills"), { recursive: true, force: true });
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});
	it("keeps bundled SKC workflow skills even when options.skills is empty", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: [],
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.map(skill => skill.name).sort()).toEqual([...DEFAULT_SKC_DEFINITION_NAMES].sort());
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills plus bundled SKC workflow skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills).toContainEqual(customSkill);
		for (const name of DEFAULT_SKC_DEFINITION_NAMES) {
			expect(session.skills.some(skill => skill.name === name)).toBe(true);
		}
		expect(session.skillWarnings).toEqual([]);
	});
});
