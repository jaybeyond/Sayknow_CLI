/**
 * Handles `skc skills` for inspecting bundled workflow and UI skill definitions.
 */
import {
	DEFAULT_SKC_DEFINITION_NAMES,
	type EmbeddedDefaultSkcSkill,
	getEmbeddedDefaultSkcSkills,
} from "../defaults/skc-defaults";
import { getEmbeddedSkcUiSkills } from "../defaults/skc-ui-skills";
import type { Skill } from "../extensibility/skills";

export type SkillsAction = "list" | "read";

export interface SkillsCommandArgs {
	action: SkillsAction;
	name?: string;
	flags?: {
		json?: boolean;
	};
}

interface SkillsListEntry {
	name: string;
	description: string;
	path: string;
	source: string;
}

interface SkillsReadEntry extends SkillsListEntry {
	content: string;
}

function getEmbeddedSkill(name: string): EmbeddedDefaultSkcSkill | Skill | undefined {
	return (
		getEmbeddedDefaultSkcSkills().find(skill => skill.name === name) ??
		getEmbeddedSkcUiSkills().find(skill => skill.name === name)
	);
}

function listEmbeddedSkills(): SkillsListEntry[] {
	const toEntry = (skill: EmbeddedDefaultSkcSkill | Skill): SkillsListEntry => ({
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		source: skill.source,
	});
	return [...getEmbeddedDefaultSkcSkills().map(toEntry), ...getEmbeddedSkcUiSkills().map(toEntry)];
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runSkillsCommand(cmd: SkillsCommandArgs): Promise<void> {
	if (cmd.action === "list") {
		const skills = listEmbeddedSkills();
		if (cmd.flags?.json) {
			writeJson({ skills });
			return;
		}
		for (const skill of skills) {
			process.stdout.write(`${skill.name}\t${skill.description}\t${skill.path}\n`);
		}
		return;
	}

	const name = cmd.name?.trim();
	if (!name) {
		process.stderr.write(
			`error: skill name is required for read (${DEFAULT_SKC_DEFINITION_NAMES.join(", ")}, or a bundled UI skill such as emil-design-eng)\n`,
		);
		process.exitCode = 1;
		return;
	}

	const skill = getEmbeddedSkill(name);
	if (!skill) {
		process.stderr.write(
			`error: unknown embedded skill "${name}" (${DEFAULT_SKC_DEFINITION_NAMES.join(", ")}, or a bundled UI skill such as emil-design-eng)\n`,
		);
		process.exitCode = 1;
		return;
	}

	// Every embedded skill carries inline content; a missing body means the
	// bundle was built wrong, so fail loudly instead of printing "undefined".
	const content = skill.content;
	if (typeof content !== "string" || content.length === 0) {
		process.stderr.write(`error: embedded skill "${name}" has no bundled content\n`);
		process.exitCode = 1;
		return;
	}

	const entry: SkillsReadEntry = {
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		source: skill.source,
		content,
	};
	if (cmd.flags?.json) {
		writeJson(entry);
		return;
	}
	process.stdout.write(content);
	if (!content.endsWith("\n")) process.stdout.write("\n");
}
