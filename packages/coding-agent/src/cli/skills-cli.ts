/**
 * Handles `skc skills` for inspecting bundled workflow, UI and security skill definitions.
 */
import { type EmbeddedDefaultSkcSkill, getEmbeddedDefaultSkcSkills } from "../defaults/skc-defaults";
import { getEmbeddedSkcSecuritySkills } from "../defaults/skc-security-skills";
import { getEmbeddedSkcUiSkills } from "../defaults/skc-ui-skills";
import type { Skill } from "../extensibility/skills";
import {
	getSkcWorkflowPublicName,
	resolveSkcWorkflowId,
	SKC_WORKFLOW_PUBLIC_NAMES,
} from "../skill-state/canonical-skills";

const visibleWorkflowNames = Object.values(SKC_WORKFLOW_PUBLIC_NAMES).join(", ");

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

function getBundledSkills(): Array<EmbeddedDefaultSkcSkill | Skill> {
	return [...getEmbeddedDefaultSkcSkills(), ...getEmbeddedSkcUiSkills(), ...getEmbeddedSkcSecuritySkills()];
}

function getEmbeddedSkill(name: string): EmbeddedDefaultSkcSkill | Skill | undefined {
	return getBundledSkills().find(skill => skill.name === (resolveSkcWorkflowId(name) ?? name));
}

function listEmbeddedSkills(): SkillsListEntry[] {
	return getBundledSkills().map(skill => ({
		name: getSkcWorkflowPublicName(skill.name),
		description: skill.description,
		path: skill.filePath,
		source: skill.source,
	}));
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
			`error: skill name is required for read (${visibleWorkflowNames}, a bundled UI skill such as emil-design-eng, or security-review)\n`,
		);
		process.exitCode = 1;
		return;
	}

	const skill = getEmbeddedSkill(name);
	if (!skill) {
		process.stderr.write(
			`error: unknown embedded skill "${name}" (${visibleWorkflowNames}, a bundled UI skill such as emil-design-eng, or security-review)\n`,
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
		name: getSkcWorkflowPublicName(skill.name),
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
