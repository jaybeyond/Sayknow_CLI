#!/usr/bin/env bun
/**
 * Regenerate the bundled skill sources under
 * `packages/coding-agent/src/defaults/skc/<bundleDir>`: the frontend UI/UX
 * skills in `ui-skills` and the security review skill in `security-skills`.
 *
 * Only `SKILL.md` is compiled into the binary, and a bundled skill's `baseDir`
 * is a virtual `embedded:skc/...` path — so a companion file left beside it on
 * disk is unreachable at runtime. Every companion markdown file is therefore
 * inlined into `SKILL.md` as an appendix, and the in-text links are rewritten
 * to the appendix anchors so the agent never tries to read a path that does
 * not exist.
 *
 * Usage:
 *   bun scripts/build-ui-skill-bundle.ts --source emilkowalski=<dir> --source appllama=<dir> --source benjitaylor=<dir> \
 *     --source pbakaus=<dir> --source motionsites=<dir> --source usestrix=<dir>
 *   bun scripts/build-ui-skill-bundle.ts --check --source ...   (verify committed output is in sync)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const defaultsRoot = path.join(repoRoot, "packages/coding-agent/src/defaults/skc");
/**
 * SKC-authored sections spliced into a vendored skill right after its
 * `## SKC invocation` block (`<overlayRoot>/<skill>.md`). They carry SKC's own
 * mandatory guidance, so a regeneration from upstream keeps them.
 */
const overlayRoot = path.join(repoRoot, "scripts/ui-skill-overlays");

interface SourceLayout {
	/** Directory holding the skill folders, relative to the checkout root. */
	skillsDir: string;
	/** Upstream license file, relative to the checkout root. */
	license: string;
	/** Companion markdown files to inline; every `.md` beside `SKILL.md` when omitted. */
	companion?: (relativePath: string) => boolean;
	/**
	 * SKC-authored `SKILL.md` (repo-relative) that replaces the upstream one.
	 * Used when the upstream entry carries instructions SKC must not ship, while
	 * its companion references are still vendored.
	 */
	entry?: string;
	/** Bundle directory under `defaults/skc`; `ui-skills` when omitted. */
	bundleDir?: string;
	/** Directory walked for companions, relative to the checkout root; the skill folder when omitted. */
	companionDir?: string;
	/** Opening lines of the `## SKC invocation` block; the frontend wording when omitted. */
	invocation?: readonly string[];
	/** Rewrites each companion before it is inlined. */
	transformCompanion?: (text: string, relativePath: string) => string;
}

interface UpstreamSource {
	id: string;
	/** Repository root of the upstream skills checkout. */
	dir: string;
	/** Skill directory names to vendor, relative to `<dir>/<layout.skillsDir>`. */
	skills: readonly string[];
	layout: SourceLayout;
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
	// SKC's design center: every frontend task loads it first.
	benjitaylor: ["stageshow"],
	// Design steering vocabulary (polish, critique, audit, bolder, quieter...).
	pbakaus: ["impeccable"],
	// Cinematic landing-page workflow; the entry is SKC-authored (see layout).
	motionsites: ["motionsites-web-builder"],
	// White-box security review of the user's own code; the entry is SKC-authored.
	usestrix: ["security-review"],
};

const DEFAULT_LAYOUT: SourceLayout = { skillsDir: "skills", license: "LICENSE" };

const SOURCE_LAYOUTS: Record<string, SourceLayout> = {
	// Skills live at the repository root and carry their own LICENSE. Only the
	// rule references and the notice are inlined: the READMEs and source lists
	// describe the kit, examples and playground, which are not vendored.
	benjitaylor: {
		skillsDir: ".",
		license: "stageshow/LICENSE",
		companion: relativePath => relativePath.startsWith("references/") || relativePath === "NOTICE.md",
	},
	// The `.pi` build matches SKC's Pi lineage. Only engine-free references are
	// vendored: `new-work` (owned by `stageshow`), `animate` (owned by
	// `animate`), the native/iOS/Android references (owned by
	// `appllama-app-design-skill`) and every reference that drives the
	// downloaded engine binary, live browser mode or hooks are left out.
	pbakaus: {
		skillsDir: ".pi/skills",
		license: "LICENSE",
		companion: relativePath => IMPECCABLE_REFERENCES.has(relativePath),
	},
	// Only the MIT part is vendored. `examples/` and `media/` are (c) MotionSites
	// and may not be redistributed as a collection, and the upstream `SKILL.md`
	// requires a paid-upgrade ad in every delivery, so SKC ships its own entry.
	// The seven technique recipe files (~285 KB) are read on demand from the
	// pinned upstream commit instead of being inlined.
	motionsites: {
		skillsDir: "plugins/motionsites-web-builder/skills",
		license: "LICENSE",
		entry: "scripts/ui-skill-overlays/motionsites-web-builder.entry.md",
		companion: relativePath =>
			relativePath.startsWith("references/") &&
			(!relativePath.startsWith("references/techniques/") || relativePath === "references/techniques/INDEX.md"),
	},
	// Strix is a Python agent runtime (Docker sandbox, proxy, browser) whose own
	// skills only drive its CLI, so SKC ships its own entry and vendors the five
	// source-review methodology documents. The live-exploitation playbooks
	// (vulnerability classes, recon, tooling, cloud) are left out: this skill
	// reviews source the user owns and never tests a running system.
	usestrix: {
		skillsDir: "strix/skills",
		license: "LICENSE",
		entry: "scripts/ui-skill-overlays/security-review.entry.md",
		bundleDir: "security-skills",
		companionDir: "strix/skills",
		companion: relativePath => STRIX_REFERENCES.has(relativePath),
		invocation: [
			"SKC loads this skill automatically for matching security review work.",
			"Do not wait for a follow-up question. Apply the review rules immediately",
			"and keep going on the user's actual task.",
		],
		transformCompanion: resolveStrixTemplate,
	},
};

const IMPECCABLE_REFERENCES = new Set(
	[
		"craft-floor",
		"mode-operate",
		"mode-persuade",
		"mode-read",
		"operate",
		"critique",
		"audit",
		"polish",
		"bolder",
		"quieter",
		"distill",
		"clarify",
		"colorize",
		"typeset",
		"layout",
		"harden",
		"adapt",
	].map(name => `reference/${name}.md`),
);

const STRIX_REFERENCES = new Set([
	"analysis/source_aware_discovery.md",
	"analysis/counterevidence.md",
	"analysis/severity_calibration.md",
	"analysis/fix_verification.md",
	"scan_modes/diff.md",
]);

/**
 * Strix renders these documents through Jinja with a `coverage_tools` flag for
 * its own coverage ledger tools. SKC has no such tools, so every conditional
 * resolves to its `else` branch. Any other template syntax fails the build
 * instead of shipping raw Jinja to the agent.
 */
function resolveStrixTemplate(text: string, relativePath: string): string {
	const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
	const resolved = body.replace(
		/\{% if coverage_tools %\}\n([\s\S]*?)\{% endif %\}\n?/g,
		(_match, inner: string) => inner.split("{% else %}\n")[1] ?? "",
	);
	if (/\{%|\{\{/.test(resolved)) throw new Error(`unresolved template syntax in ${relativePath}`);
	return resolved;
}

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

async function readOverlay(skillName: string): Promise<string> {
	const file = Bun.file(path.join(overlayRoot, `${skillName}.md`));
	return (await file.exists()) ? `\n${(await file.text()).trim()}\n` : "";
}

const UI_INVOCATION = [
	"SKC loads this skill automatically for matching frontend UI/UX work.",
	"Do not wait for a follow-up question. Apply the craft rules immediately",
	"and keep going on the user's actual task.",
] as const;

function invocationBlock(companionNames: readonly string[], opening: readonly string[] = UI_INVOCATION): string {
	const lines = ["## SKC invocation", "", ...opening];
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

async function listCompanions(skillDir: string, include: SourceLayout["companion"]): Promise<string[]> {
	const found: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") await walk(path.join(dir, entry.name), rel);
				continue;
			}
			if (entry.name === "SKILL.md" || !entry.name.endsWith(".md")) continue;
			if (include && !include(rel)) continue;
			found.push(rel);
		}
	};
	await walk(skillDir, "");
	return found;
}

async function buildSkill(source: UpstreamSource, skillName: string): Promise<string> {
	const skillDir = path.join(source.dir, source.layout.skillsDir, skillName);
	const entry = source.layout.entry ? path.join(repoRoot, source.layout.entry) : path.join(skillDir, "SKILL.md");
	const raw = await Bun.file(entry).text();
	const frontmatterMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
	const frontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
	let body = frontmatterMatch ? raw.slice(frontmatter.length) : raw;

	const companionDir = source.layout.companionDir ? path.join(source.dir, source.layout.companionDir) : skillDir;
	const companions = await listCompanions(companionDir, source.layout.companion);
	body = stripInitialResponse(body);
	body = rewriteCompanionLinks(body, companions);
	body = insertAfterTitle(
		body,
		invocationBlock(companions, source.layout.invocation) + (await readOverlay(skillName)),
	);

	const appendices: string[] = [];
	for (const companion of companions) {
		const raw = await Bun.file(path.join(companionDir, companion)).text();
		const text = (source.layout.transformCompanion?.(raw, companion) ?? raw).trim();
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
		sources.push({ id, dir: path.resolve(dir), skills, layout: SOURCE_LAYOUTS[id] ?? DEFAULT_LAYOUT });
	}
	return sources;
}

const argv = Bun.argv.slice(2);
const check = argv.includes("--check");
const sources = await readSources(argv);
if (sources.length === 0) {
	console.error(
		"usage: bun scripts/build-ui-skill-bundle.ts --source emilkowalski=<dir> [--source appllama=<dir>] [--source benjitaylor=<dir>] [--source pbakaus=<dir>] [--source motionsites=<dir>] [--source usestrix=<dir>]",
	);
	process.exit(2);
}

const drift: string[] = [];
for (const source of sources) {
	const bundleRoot = path.join(defaultsRoot, source.layout.bundleDir ?? "ui-skills");
	for (const skillName of source.skills) {
		const content = await buildSkill(source, skillName);
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
	const license = path.join(source.dir, source.layout.license);
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
