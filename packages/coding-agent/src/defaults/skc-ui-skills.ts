import { parseFrontmatter } from "@sayknow-cli/utils";
import type { Skill } from "../extensibility/skills";
import animateSkill from "./skc/ui-skills/animate/SKILL.md" with { type: "text" };
import animationVocabularySkill from "./skc/ui-skills/animation-vocabulary/SKILL.md" with { type: "text" };
import antislopSkill from "./skc/ui-skills/antislop/SKILL.md" with { type: "text" };
import antislopCopywritingSkill from "./skc/ui-skills/antislop-copywriting/SKILL.md" with { type: "text" };
import antislopHumanSkill from "./skc/ui-skills/antislop-human/SKILL.md" with { type: "text" };
import antislopLayoutmobileSkill from "./skc/ui-skills/antislop-layoutmobile/SKILL.md" with { type: "text" };
import antislopUiSkill from "./skc/ui-skills/antislop-ui/SKILL.md" with { type: "text" };
import appleDesignSkill from "./skc/ui-skills/apple-design/SKILL.md" with { type: "text" };
import appllamaAppDesignSkill from "./skc/ui-skills/appllama-app-design-skill/SKILL.md" with { type: "text" };
import askSonnerSkill from "./skc/ui-skills/ask-sonner/SKILL.md" with { type: "text" };
import emilDesignEngSkill from "./skc/ui-skills/emil-design-eng/SKILL.md" with { type: "text" };
import findAnimationOpportunitiesSkill from "./skc/ui-skills/find-animation-opportunities/SKILL.md" with {
	type: "text",
};
import impeccableSkill from "./skc/ui-skills/impeccable/SKILL.md" with { type: "text" };
import improveAnimationsSkill from "./skc/ui-skills/improve-animations/SKILL.md" with { type: "text" };
import mobileNativeSkill from "./skc/ui-skills/mobile-native/SKILL.md" with { type: "text" };
import motionsitesWebBuilderSkill from "./skc/ui-skills/motionsites-web-builder/SKILL.md" with { type: "text" };
import pickUiLibrarySkill from "./skc/ui-skills/pick-ui-library/SKILL.md" with { type: "text" };
import prototypeSkill from "./skc/ui-skills/prototype/SKILL.md" with { type: "text" };
import reactBitsSkill from "./skc/ui-skills/react-bits/SKILL.md" with { type: "text" };
import reviewAnimationsSkill from "./skc/ui-skills/review-animations/SKILL.md" with { type: "text" };
import stageshowSkill from "./skc/ui-skills/stageshow/SKILL.md" with { type: "text" };
import unslopSkill from "./skc/ui-skills/unslop/SKILL.md" with { type: "text" };

/**
 * Bundled frontend UI/UX craft skills. These are NOT public SKC workflow skills.
 * The four public workflows remain deep-interview, ralplan, ultragoal, and team.
 *
 * Sources and deliberate exclusions are documented in
 * `skc/ui-skills/NOTICE.md`; regenerate with `scripts/build-ui-skill-bundle.ts`.
 */
export const BUNDLED_SKC_UI_SKILL_NAMES = [
	"stageshow",
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
	"impeccable",
	"motionsites-web-builder",
	"unslop",
	"antislop",
	"antislop-ui",
	"antislop-human",
	"antislop-layoutmobile",
	"antislop-copywriting",
] as const;

export type BundledSkcUiSkillName = (typeof BUNDLED_SKC_UI_SKILL_NAMES)[number];

interface BundledUiSkillSource {
	name: BundledSkcUiSkillName;
	relativePath: string;
	content: string;
}

const BUNDLED_UI_SKILL_SOURCES: readonly BundledUiSkillSource[] = [
	{ name: "stageshow", relativePath: "ui-skills/stageshow/SKILL.md", content: stageshowSkill },
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
	{ name: "impeccable", relativePath: "ui-skills/impeccable/SKILL.md", content: impeccableSkill },
	{
		name: "motionsites-web-builder",
		relativePath: "ui-skills/motionsites-web-builder/SKILL.md",
		content: motionsitesWebBuilderSkill,
	},
	{ name: "unslop", relativePath: "ui-skills/unslop/SKILL.md", content: unslopSkill },
	{ name: "antislop", relativePath: "ui-skills/antislop/SKILL.md", content: antislopSkill },
	{ name: "antislop-ui", relativePath: "ui-skills/antislop-ui/SKILL.md", content: antislopUiSkill },
	{ name: "antislop-human", relativePath: "ui-skills/antislop-human/SKILL.md", content: antislopHumanSkill },
	{
		name: "antislop-layoutmobile",
		relativePath: "ui-skills/antislop-layoutmobile/SKILL.md",
		content: antislopLayoutmobileSkill,
	},
	{
		name: "antislop-copywriting",
		relativePath: "ui-skills/antislop-copywriting/SKILL.md",
		content: antislopCopywritingSkill,
	},
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
