import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const expectedWorkflowSkills = ["deep-interview", "ralplan", "team", "ultragoal"];

describe("SKC dogfood skill template", () => {
	it("documents local override installation without changing the default workflow surface", async () => {
		const template = await Bun.file(path.join(repoRoot, "docs", "skc-dogfood-skill-template.md")).text();
		const defaultSkillsDir = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "skc", "skills");
		const defaultSkillEntries = await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan(defaultSkillsDir));
		const defaultSkillNames = defaultSkillEntries.map(entry => entry.split("/")[0]).sort();

		expect(defaultSkillNames).toEqual(expectedWorkflowSkills);
		expect(template).toContain("~/.skc/skills/skc-dogfood/SKILL.md");
		expect(template).toContain("<project>/.skc/skills/skc-dogfood/SKILL.md");
		expect(template).toContain("The live issue has no comment approving a fifth bundled default workflow skill");
		expect(template).toContain("Use when running or reviewing work through SKC sessions");
		expect(template).toContain("skc --tmux --worktree <branch-like-name>");
		expect(template).toContain("Do not pass filesystem paths to `--worktree`");
		expect(template).toContain("sayknow-cli-93-dogfood-skill");
		expect(template).toContain("Verify the prompt was accepted");
		expect(template).toContain("create or link the sayknow-cli issue");
	});
});
