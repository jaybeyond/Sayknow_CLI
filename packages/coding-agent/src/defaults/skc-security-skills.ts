import { parseFrontmatter } from "@sayknow-cli/utils";
import type { Skill } from "../extensibility/skills";
import securityReviewSkill from "./skc/security-skills/security-review/SKILL.md" with { type: "text" };

/**
 * Bundled security review skill. Like the UI craft skills it is NOT a public
 * SKC workflow skill: the four public workflows remain deep-interview, ralplan,
 * ultragoal, and team.
 *
 * The source and deliberate exclusions are documented in
 * `skc/security-skills/NOTICE.md`; regenerate with `scripts/build-ui-skill-bundle.ts`.
 */
export const BUNDLED_SKC_SECURITY_SKILL_NAMES = ["security-review"] as const;

export type BundledSkcSecuritySkillName = (typeof BUNDLED_SKC_SECURITY_SKILL_NAMES)[number];

const BUNDLED_SECURITY_SKILL_CONTENT: Record<BundledSkcSecuritySkillName, string> = {
	"security-review": securityReviewSkill,
};

export function getEmbeddedSkcSecuritySkills(): Skill[] {
	return BUNDLED_SKC_SECURITY_SKILL_NAMES.map(name => {
		const content = BUNDLED_SECURITY_SKILL_CONTENT[name];
		const filePath = `embedded:skc/security-skills/${name}/SKILL.md`;
		const { frontmatter } = parseFrontmatter(content, { source: filePath, level: "warn" });
		return {
			name,
			description:
				typeof frontmatter.description === "string" ? frontmatter.description : `SKC security skill ${name}`,
			filePath,
			baseDir: `embedded:skc/security-skills/${name}`,
			source: "bundled:security",
			hide: false,
			content,
		};
	});
}

export function withEmbeddedSkcSecuritySkills(skills: Skill[]): Skill[] {
	const names = new Set(skills.map(skill => skill.name));
	return [...skills, ...getEmbeddedSkcSecuritySkills().filter(skill => !names.has(skill.name))];
}
