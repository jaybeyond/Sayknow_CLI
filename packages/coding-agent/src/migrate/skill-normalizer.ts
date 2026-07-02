/**
 * Normalize a skill from another agent into a native SKC `SKILL.md`.
 *
 * SKC derives a skill's loaded name from its directory (`<slug>/SKILL.md`) when no
 * frontmatter `name` is present, and requires a `description`. To guarantee the
 * effective loaded name equals the lowercase-hyphen slug, we drop any frontmatter
 * `name` and place the file at `<slug>/SKILL.md`, synthesizing a `description`
 * when the source lacks one.
 */

import { parseFrontmatter } from "@sayknow-cli/utils";
import { YAML } from "bun";

export interface NormalizeSkillInput {
	/** Raw name from the source (filename stem, frontmatter name, etc.). */
	rawName: string;
	/** Full source markdown (may or may not have frontmatter). */
	content: string;
}

export interface NormalizedSkill {
	slug: string;
	content: string;
	warnings: string[];
}

/** Convert an arbitrary name into a lowercase-hyphen slug. */
export function slugify(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug;
}

function firstNonEmptyLine(body: string): string | undefined {
	for (const raw of body.split("\n")) {
		const line = raw.replace(/^#+\s*/, "").trim();
		if (line) return line;
	}
	return undefined;
}

/**
 * Produce a `{ slug, content }` pair whose effective SKC-loaded name equals `slug`.
 * Throws only on an unusable name (cannot produce a slug).
 */
export function normalizeSkill(input: NormalizeSkillInput): NormalizedSkill {
	const warnings: string[] = [];
	const { frontmatter, body } = parseFrontmatter(input.content, { level: "off" });

	const sourceName =
		typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name : input.rawName;
	const slug = slugify(sourceName);
	if (!slug) {
		throw new Error(`cannot derive a valid slug from skill name "${input.rawName}"`);
	}
	if (slugify(input.rawName) !== slug && typeof frontmatter.name === "string") {
		warnings.push(`renamed skill "${input.rawName}" to slug "${slug}"`);
	}

	// Build the destination frontmatter: drop `name` (loaded name comes from the dir),
	// keep other fields, and ensure a non-empty description.
	const { name: _droppedName, description: rawDescription, ...rest } = frontmatter;
	let description = typeof rawDescription === "string" ? rawDescription.trim() : "";
	if (!description) {
		description = firstNonEmptyLine(body) ?? `Imported ${slug} skill.`;
		warnings.push(`synthesized description for skill "${slug}"`);
	}

	const fm: Record<string, unknown> = { description, ...rest };
	const yaml = YAML.stringify(fm).trimEnd();
	const content = `---\n${yaml}\n---\n\n${body.trim()}\n`;

	return { slug, content, warnings };
}
