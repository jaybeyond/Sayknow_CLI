import { parseFrontmatter } from "@sayknow-cli/utils";
import type { Skill } from "../extensibility/skills";
import animateSkill from "./skc/ui-skills/animate/SKILL.md" with { type: "text" };
import animationVocabularySkill from "./skc/ui-skills/animation-vocabulary/SKILL.md" with { type: "text" };
import appleDesignSkill from "./skc/ui-skills/apple-design/SKILL.md" with { type: "text" };
import appllamaAppDesignSkill from "./skc/ui-skills/appllama-app-design-skill/SKILL.md" with { type: "text" };
import askSonnerSkill from "./skc/ui-skills/ask-sonner/SKILL.md" with { type: "text" };
import emilDesignEngSkill from "./skc/ui-skills/emil-design-eng/SKILL.md" with { type: "text" };
import findAnimationOpportunitiesSkill from "./skc/ui-skills/find-animation-opportunities/SKILL.md" with {
	type: "text",
};
import improveAnimationsSkill from "./skc/ui-skills/improve-animations/SKILL.md" with { type: "text" };
import mobileNativeSkill from "./skc/ui-skills/mobile-native/SKILL.md" with { type: "text" };
import pickUiLibrarySkill from "./skc/ui-skills/pick-ui-library/SKILL.md" with { type: "text" };
import prototypeSkill from "./skc/ui-skills/prototype/SKILL.md" with { type: "text" };
import reactBitsSkill from "./skc/ui-skills/react-bits/SKILL.md" with { type: "text" };
import reviewAnimationsSkill from "./skc/ui-skills/review-animations/SKILL.md" with { type: "text" };

/**
 * Bundled frontend UI/UX craft skills. These are NOT public SKC workflow skills.
 * The four public workflows remain deep-interview, ralplan, ultragoal, and team.
 *
 * Sources and deliberate exclusions are documented in
 * `skc/ui-skills/NOTICE.md`; regenerate with `scripts/build-ui-skill-bundle.ts`.
 */
export const BUNDLED_SKC_UI_SKILL_NAMES = [
	"emil-design-eng",
	"animate",
	"review-animations",
	"improve-animations",
	"find-animation-opportunities",
	"pick-ui-library",
	"prototype",
	"mobile-native",
	"animation-vocabulary",
	"apple-design",
	"ask-sonner",
	"appllama-app-design-skill",
	"react-bits",
] as const;

export type BundledSkcUiSkillName = (typeof BUNDLED_SKC_UI_SKILL_NAMES)[number];

interface BundledUiSkillSource {
	name: BundledSkcUiSkillName;
	relativePath: string;
	content: string;
}

const BUNDLED_UI_SKILL_SOURCES: readonly BundledUiSkillSource[] = [
	{ name: "emil-design-eng", relativePath: "ui-skills/emil-design-eng/SKILL.md", content: emilDesignEngSkill },
	{ name: "animate", relativePath: "ui-skills/animate/SKILL.md", content: animateSkill },
	{ name: "review-animations", relativePath: "ui-skills/review-animations/SKILL.md", content: reviewAnimationsSkill },
	{
		name: "improve-animations",
		relativePath: "ui-skills/improve-animations/SKILL.md",
		content: improveAnimationsSkill,
	},
	{
		name: "find-animation-opportunities",
		relativePath: "ui-skills/find-animation-opportunities/SKILL.md",
		content: findAnimationOpportunitiesSkill,
	},
	{ name: "pick-ui-library", relativePath: "ui-skills/pick-ui-library/SKILL.md", content: pickUiLibrarySkill },
	{ name: "prototype", relativePath: "ui-skills/prototype/SKILL.md", content: prototypeSkill },
	{ name: "mobile-native", relativePath: "ui-skills/mobile-native/SKILL.md", content: mobileNativeSkill },
	{
		name: "animation-vocabulary",
		relativePath: "ui-skills/animation-vocabulary/SKILL.md",
		content: animationVocabularySkill,
	},
	{ name: "apple-design", relativePath: "ui-skills/apple-design/SKILL.md", content: appleDesignSkill },
	{ name: "ask-sonner", relativePath: "ui-skills/ask-sonner/SKILL.md", content: askSonnerSkill },
	{
		name: "appllama-app-design-skill",
		relativePath: "ui-skills/appllama-app-design-skill/SKILL.md",
		content: appllamaAppDesignSkill,
	},
	{ name: "react-bits", relativePath: "ui-skills/react-bits/SKILL.md", content: reactBitsSkill },
];

export function getEmbeddedSkcUiSkills(): Skill[] {
	return BUNDLED_UI_SKILL_SOURCES.map(source => {
		const { frontmatter } = parseFrontmatter(source.content, {
			source: `embedded:skc/${source.relativePath}`,
			level: "warn",
		});
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description : `SKC UI skill ${source.name}`;
		return {
			name: source.name,
			description,
			filePath: `embedded:skc/${source.relativePath}`,
			baseDir: `embedded:skc/ui-skills/${source.name}`,
			source: "bundled:ui",
			hide: false,
			content: source.content,
		};
	});
}

export function withEmbeddedSkcUiSkills(skills: Skill[]): Skill[] {
	const byName = new Map(skills.map(skill => [skill.name, skill]));
	for (const uiSkill of getEmbeddedSkcUiSkills()) {
		if (!byName.has(uiSkill.name)) byName.set(uiSkill.name, uiSkill);
	}
	return [...byName.values()];
}
