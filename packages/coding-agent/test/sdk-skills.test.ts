import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { DEFAULT_SKC_DEFINITION_NAMES } from "@sayknow-cli/coding-agent/defaults/skc-defaults";
import { BUNDLED_SKC_SECURITY_SKILL_NAMES } from "@sayknow-cli/coding-agent/defaults/skc-security-skills";
import { BUNDLED_SKC_UI_SKILL_NAMES } from "@sayknow-cli/coding-agent/defaults/skc-ui-skills";
import type { Skill } from "@sayknow-cli/coding-agent/sdk";
import { createAgentSession } from "@sayknow-cli/coding-agent/sdk";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { SKC_WORKFLOW_PUBLIC_NAMES } from "@sayknow-cli/coding-agent/skill-state/canonical-skills";
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

	it("loads embedded default SKC workflow skills without explicit discovery settings", async () => {
		fs.rmSync(path.join(tempDir, ".skc"), { recursive: true, force: true });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
		});
		const expected = [
			...DEFAULT_SKC_DEFINITION_NAMES,
			...BUNDLED_SKC_UI_SKILL_NAMES,
			...BUNDLED_SKC_SECURITY_SKILL_NAMES,
		].sort();

		expect(session.skills.map(skill => skill.name).sort()).toEqual(expected);
		expect(session.skills.every(skill => skill.filePath.startsWith("embedded:skc/"))).toBe(true);
	}, 15_000);

	it("disables both workflow spellings when skills are explicitly disabled", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "skills.enabled": false }),
		});
		try {
			expect(session.getAllToolNames()).not.toContain("skill");
			for (const name of Object.entries(SKC_WORKFLOW_PUBLIC_NAMES).flat()) {
				expect(session.resolvePromptSkillInvocation(`/skill:${name}`)).toBeUndefined();
			}
		} finally {
			await session.dispose();
		}
	});

	it.each(["deep-interview", "sonar"])("filters both reserved aliases when %s is ignored", async name => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "skills.ignoredSkills": [name] }),
		});
		try {
			const tool = session.getToolByName("skill");
			if (!tool) throw new Error("Expected skill tool for other workflows");
			for (const spelling of ["deep-interview", "sonar"]) {
				expect(session.resolvePromptSkillInvocation(`/skill:${spelling}`)).toBeUndefined();
				await expect(tool.execute("test-filter", { name: spelling })).rejects.toThrow("unknown skill");
			}
		} finally {
			await session.dispose();
		}
	});

	it.each(["deep-interview", "sonar"])("shares the disabled workflow ID for %s", async name => {
		const settings = Settings.isolated({ "skills.enabled": true, disabledExtensions: [`skill:${name}`] });
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settings,
		});
		try {
			const tool = session.getToolByName("skill");
			if (!tool) throw new Error("Expected skill tool for enabled workflows");
			for (const spelling of ["deep-interview", "sonar"]) {
				expect(session.resolvePromptSkillInvocation(`/skill:${spelling}`)).toBeUndefined();
				await expect(tool.execute("test", { name: spelling })).rejects.toThrow("unknown skill");
			}
		} finally {
			await session.dispose();
		}
	});

	it.each(
		Object.entries(SKC_WORKFLOW_PUBLIC_NAMES).flatMap(
			([id, name]) =>
				[
					[id, id, name],
					[name, id, name],
				] as const,
		),
	)("dispatches %s to the same project override", async (spelling, id, publicName) => {
		const makeProjectSkill = async (name: string, body: string) => {
			const file = path.join(path.dirname(skillsDir), name, "SKILL.md");
			await Bun.write(file, `---\nname: ${name}\ndescription: SDK alias fixture\n---\n\n${body}\n`);
			return file;
		};
		const override = await makeProjectSkill(id, "Override body for both names.");
		await makeProjectSkill(publicName, "Reserved collision body.");
		const prefix = await makeProjectSkill(`${publicName}-extra`, "Prefix skill body.");
		const manager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: manager,
			settings: createIsolatedSkillsSettings(),
		});
		try {
			expect(session.resolvePromptSkillInvocation(`/skill:${spelling}`)?.skill.filePath).toBe(override);
			expect(session.resolvePromptSkillInvocation(`/skill:${publicName}-extra`)?.skill.filePath).toBe(prefix);
			const tool = session.getToolByName("skill");
			if (!tool) throw new Error("Expected skill tool");
			const result = await tool.execute("test-override", { name: spelling });
			expect(result.details).toMatchObject({ name: id, path: override });
			expect(JSON.stringify(manager.getEntries())).toContain("Override body for both names.");
			expect(JSON.stringify(manager.getEntries())).not.toContain("Reserved collision body.");
		} finally {
			await session.dispose();
		}
	});

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

		expect(session.skills.map(skill => skill.name).sort()).toEqual(
			[...DEFAULT_SKC_DEFINITION_NAMES, ...BUNDLED_SKC_UI_SKILL_NAMES, ...BUNDLED_SKC_SECURITY_SKILL_NAMES].sort(),
		);
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
		for (const name of [...BUNDLED_SKC_UI_SKILL_NAMES, ...BUNDLED_SKC_SECURITY_SKILL_NAMES]) {
			expect(session.skills.some(skill => skill.name === name)).toBe(true);
		}
		expect(session.skillWarnings).toEqual([]);
	});
});
