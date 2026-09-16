#!/usr/bin/env bun
/**
 * Regenerate the bundled frontend UI/UX skill sources under
 * `packages/coding-agent/src/defaults/skc/ui-skills`.
 *
 * Only `SKILL.md` is compiled into the binary, and a bundled skill's `baseDir`
 * is a virtual `embedded:skc/...` path — so a companion file left beside it on
 * disk is unreachable at runtime. Every companion markdown file is therefore
 * inlined into `SKILL.md` as an appendix, and the in-text links are rewritten
 * to the appendix anchors so the agent never tries to read a path that does
 * not exist.
 *
 * Usage:
 *   bun scripts/build-ui-skill-bundle.ts --source emilkowalski=<dir> --source appllama=<dir>
 *   bun scripts/build-ui-skill-bundle.ts --check   (verify committed output is in sync)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const bundleRoot = path.join(repoRoot, "packages/coding-agent/src/defaults/skc/ui-skills");

interface UpstreamSource {
	id: string;
	/** Repository root of the upstream skills checkout. */
	dir: string;
	/** Skill directory names to vendor, relative to `<dir>/skills`. */
	skills: readonly string[];
}

const SOURCE_SKILLS: Record<string, readonly string[]> = {
	// Web frontend craft. `write-swift` and `animate-expo` are out of scope.
	emilkowalski: [
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
	],
	// Native mobile screen craft. `appllama-usage` is excluded: it only drives
	// the paid Appllama MCP, which SKC does not ship or enable.
	appllama: ["appllama-app-design-skill"],
};


/**
 * Skills authored by SKC rather than vendored from an upstream checkout.
 * `react-bits` is first-party guidance for a registry whose components SKC is
 * not licensed to redistribute; the generator must never overwrite it or
 * report it as drift.
 */
export const FIRST_PARTY_UI_SKILLS = ["react-bits"] as const;

function appendixAnchor(fileName: string): string {
	return `#appendix-${fileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** Drop the upstream "wait for the user to ask" greeting; SKC auto-invokes. */
function stripInitialResponse(body: string): string {
	const heading = "## Initial Response";
	const start = body.indexOf(heading);
	if (start < 0) return body;
	const rest = body.slice(start + heading.length);
	const nextHeading = rest.search(/\n##? /);
	return nextHeading < 0 ? body.slice(0, start) : body.slice(0, start) + rest.slice(nextHeading + 1);
}

function invocationBlock(companionNames: readonly string[]): string {
	const lines = [
		"## SKC invocation",
		"",
		"SKC loads this skill automatically for matching frontend UI/UX work.",
		"Do not wait for a follow-up question. Apply the craft rules immediately",
		"and keep going on the user's actual task.",
	];
	if (companionNames.length > 0) {
		lines.push(
			"",
			"This skill's companion reference files are appended inline at the end of",
			"this document. Read them there; they are not separate files on disk.",
		);
	}
	return `${lines.join("\n")}\n`;
}

function insertAfterTitle(body: string, block: string): string {
	const match = body.match(/^# .*$/m);
	if (!match || match.index === undefined) return `${block}\n${body}`;
	const cut = match.index + match[0].length;
	return `${body.slice(0, cut)}\n\n${block}${body.slice(cut)}`;
}

function rewriteCompanionLinks(body: string, companions: readonly string[]): string {
	let out = body;
	for (const companion of companions) {
		const base = path.basename(companion);
		const escaped = companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replaceAll(new RegExp(`\\]\\(\\.?/?${escaped}\\)`, "g"), `](${appendixAnchor(base)})`);
		out = out.replaceAll(new RegExp(`\\]\\(\\.?/?${escapedBase}\\)`, "g"), `](${appendixAnchor(base)})`);
	}
	return out;
}

async function listCompanions(skillDir: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(path.join(dir, entry.name), rel);
				continue;
			}
			if (entry.name === "SKILL.md" || !entry.name.endsWith(".md")) continue;
			found.push(rel);
		}
	};
	await walk(skillDir, "");
	return found;
}

async function buildSkill(sourceDir: string, skillName: string): Promise<string> {
	const skillDir = path.join(sourceDir, "skills", skillName);
	const raw = await Bun.file(path.join(skillDir, "SKILL.md")).text();
	const frontmatterMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
	const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
	let body = frontmatterMatch ? raw.slice(frontmatter.length) : raw;

	const companions = await listCompanions(skillDir);
	body = stripInitialResponse(body);
	body = rewriteCompanionLinks(body, companions);
	body = insertAfterTitle(body, invocationBlock(companions));

	const appendices: string[] = [];
	for (const companion of companions) {
		const text = (await Bun.file(path.join(skillDir, companion)).text()).trim();
		const base = path.basename(companion);
		appendices.push(`## Appendix: ${base}\n\n${rewriteCompanionLinks(text, companions)}`);
	}

	const assembled = appendices.length > 0 ? `${body.trimEnd()}\n\n---\n\n${appendices.join("\n\n---\n\n")}\n` : body;
	return `${frontmatter}${assembled}`;
}

async function readSources(argv: string[]): Promise<UpstreamSource[]> {
	const sources: UpstreamSource[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--source") continue;
		const value = argv[i + 1];
		if (!value) throw new Error("--source requires <id>=<dir>");
		const [id, dir] = value.split("=", 2);
		if (!id || !dir) throw new Error(`invalid --source value: ${value}`);
		const skills = SOURCE_SKILLS[id];
		if (!skills) throw new Error(`unknown source id: ${id}`);
		sources.push({ id, dir: path.resolve(dir), skills });
	}
	return sources;
}

const argv = Bun.argv.slice(2);
const check = argv.includes("--check");
const sources = await readSources(argv);
if (sources.length === 0) {
	console.error("usage: bun scripts/build-ui-skill-bundle.ts --source emilkowalski=<dir> [--source appllama=<dir>]");
	process.exit(2);
}

const drift: string[] = [];
for (const source of sources) {
	for (const skillName of source.skills) {
		const content = await buildSkill(source.dir, skillName);
		const target = path.join(bundleRoot, skillName, "SKILL.md");
		if (check) {
			const existing = await Bun.file(target)
				.text()
				.catch(() => null);
			if (existing !== content) drift.push(path.relative(repoRoot, target));
			continue;
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, content);
		console.log(`wrote ${path.relative(repoRoot, target)} (${content.split("\n").length} lines)`);
	}
	const license = path.join(source.dir, "LICENSE");
	const licenseTarget = path.join(bundleRoot, `LICENSE.${source.id}`);
	const licenseText = await Bun.file(license).text();
	if (check) {
		const existing = await Bun.file(licenseTarget)
			.text()
			.catch(() => null);
		if (existing !== licenseText) drift.push(path.relative(repoRoot, licenseTarget));
	} else {
		await Bun.write(licenseTarget, licenseText);
	}
}

if (check && drift.length > 0) {
	console.error(`UI skill bundle is out of sync:\n${drift.map(entry => `  - ${entry}`).join("\n")}`);
	process.exit(1);
}
console.log(check ? "UI skill bundle is in sync." : "UI skill bundle regenerated.");
