import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@sayknow-cli/utils";
import autoAnswerUncertainFragment from "./skc/skills/deep-interview/auto-answer-uncertain.md" with { type: "text" };
import autoResearchGreenfieldFragment from "./skc/skills/deep-interview/auto-research-greenfield.md" with {
	type: "text",
};
import lateralReviewPanelFragment from "./skc/skills/deep-interview/lateral-review-panel.md" with { type: "text" };
import deepInterviewSkill from "./skc/skills/deep-interview/SKILL.md" with { type: "text" };
import ralplanSkill from "./skc/skills/ralplan/SKILL.md" with { type: "text" };
import teamSkill from "./skc/skills/team/SKILL.md" with { type: "text" };
import aiSlopCleanerFragment from "./skc/skills/ultragoal/ai-slop-cleaner.md" with { type: "text" };
import pipelineValidationContractsFragment from "./skc/skills/ultragoal/pipeline-validation-contracts.md" with {
	type: "text",
};
import ultragoalSkill from "./skc/skills/ultragoal/SKILL.md" with { type: "text" };

export const DEFAULT_SKC_DEFINITION_NAMES = ["deep-interview", "ralplan", "team", "ultragoal"] as const;
export type DefaultSkcDefinitionName = (typeof DEFAULT_SKC_DEFINITION_NAMES)[number];
export type DefaultSkcDefinitionKind = "skill" | "skill-fragment";
export type EmbeddedDefaultSkcSkill = {
	name: DefaultSkcDefinitionName;
	description: string;
	filePath: string;
	baseDir: string;
	source: "bundled:default";
	hide?: boolean;
	content: string;
};
export type DefaultSkcInstallStatus = "different" | "matching" | "missing" | "skipped" | "written";

export interface DefaultSkcSkillDefinition {
	kind: "skill";
	name: DefaultSkcDefinitionName;
	relativePath: string;
	content: string;
}

export interface DefaultSkcSkillFragmentDefinition {
	kind: "skill-fragment";
	parentSkillName: DefaultSkcDefinitionName;
	relativePath: string;
	content: string;
}

export type DefaultSkcDefinition = DefaultSkcSkillDefinition | DefaultSkcSkillFragmentDefinition;

export interface InstallDefaultSkcDefinitionsOptions {
	check?: boolean;
	force?: boolean;
	/**
	 * Only rewrite default definition files that already exist on disk but whose
	 * content differs from the embedded defaults. Files that are absent are left
	 * absent (status "missing"). Used by `skc update` to refresh opted-in copies
	 * without materializing new on-disk copies for users who never installed them.
	 */
	refreshOnly?: boolean;
	targetRoot?: string;
}

export type DefaultSkcDefinitionInstallFile =
	| {
			kind: "skill";
			name: DefaultSkcDefinitionName;
			path: string;
			status: DefaultSkcInstallStatus;
	  }
	| {
			kind: "skill-fragment";
			parentSkillName: DefaultSkcDefinitionName;
			path: string;
			status: DefaultSkcInstallStatus;
	  };

export interface DefaultSkcDefinitionInstallResult {
	targetRoot: string;
	total: number;
	written: number;
	skipped: number;
	matching: number;
	missing: number;
	different: number;
	files: DefaultSkcDefinitionInstallFile[];
}

const DEFAULT_SKC_DEFINITIONS: readonly DefaultSkcDefinition[] = [
	{
		kind: "skill",
		name: "deep-interview",
		relativePath: "skills/deep-interview/SKILL.md",
		content: deepInterviewSkill,
	},
	{ kind: "skill", name: "ralplan", relativePath: "skills/ralplan/SKILL.md", content: ralplanSkill },
	{ kind: "skill", name: "team", relativePath: "skills/team/SKILL.md", content: teamSkill },
	{ kind: "skill", name: "ultragoal", relativePath: "skills/ultragoal/SKILL.md", content: ultragoalSkill },
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-research-greenfield.md",
		content: autoResearchGreenfieldFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/auto-answer-uncertain.md",
		content: autoAnswerUncertainFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "deep-interview",
		relativePath: "skill-fragments/deep-interview/lateral-review-panel.md",
		content: lateralReviewPanelFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/ai-slop-cleaner.md",
		content: aiSlopCleanerFragment,
	},
	{
		kind: "skill-fragment",
		parentSkillName: "ultragoal",
		relativePath: "skill-fragments/ultragoal/pipeline-validation-contracts.md",
		content: pipelineValidationContractsFragment,
	},
];

export function getDefaultSkcDefinitions(): readonly DefaultSkcDefinition[] {
	return DEFAULT_SKC_DEFINITIONS;
}

export function getDefaultSkcAgentDefinitions(): readonly DefaultSkcDefinition[] {
	return [];
}

export function getEmbeddedDefaultSkcSkillFragments(
	parentSkillName: DefaultSkcDefinitionName,
): DefaultSkcSkillFragmentDefinition[] {
	return DEFAULT_SKC_DEFINITIONS.filter(
		(definition): definition is DefaultSkcSkillFragmentDefinition =>
			definition.kind === "skill-fragment" && definition.parentSkillName === parentSkillName,
	);
}

export function getEmbeddedDefaultSkcSkills(): EmbeddedDefaultSkcSkill[] {
	return DEFAULT_SKC_DEFINITIONS.filter(
		(definition): definition is DefaultSkcSkillDefinition => definition.kind === "skill",
	).map(definition => {
		const { frontmatter } = parseFrontmatter(definition.content, {
			source: `embedded:skc/${definition.relativePath}`,
			level: "warn",
		});
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description : `SKC ${definition.name} workflow`;
		return {
			name: definition.name,
			description,
			filePath: `embedded:skc/${definition.relativePath}`,
			baseDir: `embedded:skc/skills/${definition.name}`,
			source: "bundled:default",
			hide: frontmatter.hide === true,
			content: definition.content,
		};
	});
}

export async function installDefaultSkcDefinitions(
	options: InstallDefaultSkcDefinitionsOptions = {},
): Promise<DefaultSkcDefinitionInstallResult> {
	const targetRoot = options.targetRoot ?? getAgentDir();
	const files: DefaultSkcDefinitionInstallFile[] = [];

	for (const definition of DEFAULT_SKC_DEFINITIONS) {
		const destination = path.join(targetRoot, definition.relativePath);
		const existing = await readExistingText(destination);
		let status: DefaultSkcInstallStatus;

		if (options.check) {
			status = existing === undefined ? "missing" : existing === definition.content ? "matching" : "different";
		} else if (options.refreshOnly) {
			if (existing === undefined) {
				status = "missing";
			} else if (existing === definition.content) {
				status = "matching";
			} else {
				await Bun.write(destination, definition.content);
				status = "written";
			}
		} else if (existing !== undefined && !options.force) {
			status = "skipped";
		} else {
			await Bun.write(destination, definition.content);
			status = "written";
		}

		if (definition.kind === "skill") {
			files.push({
				kind: definition.kind,
				name: definition.name,
				path: destination,
				status,
			});
		} else {
			files.push({
				kind: definition.kind,
				parentSkillName: definition.parentSkillName,
				path: destination,
				status,
			});
		}
	}

	return summarizeInstallResult(targetRoot, files);
}

async function readExistingText(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function summarizeInstallResult(
	targetRoot: string,
	files: DefaultSkcDefinitionInstallFile[],
): DefaultSkcDefinitionInstallResult {
	return {
		targetRoot,
		total: files.length,
		written: countStatus(files, "written"),
		skipped: countStatus(files, "skipped"),
		matching: countStatus(files, "matching"),
		missing: countStatus(files, "missing"),
		different: countStatus(files, "different"),
		files,
	};
}

function countStatus(files: readonly DefaultSkcDefinitionInstallFile[], status: DefaultSkcInstallStatus): number {
	return files.filter(file => file.status === status).length;
}
