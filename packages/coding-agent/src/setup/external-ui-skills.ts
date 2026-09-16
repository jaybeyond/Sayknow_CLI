/**
 * Install the frontend UI skills SKC routes to but cannot bundle.
 *
 * Most UI craft skills are compiled into the binary (see
 * `defaults/skc-ui-skills.ts`). A few upstreams license their content for use
 * but forbid redistributing the collection, so SKC must not carry them. For
 * those, this installs upstream's own published payload into the project, where
 * SKC's skill discovery picks it up like any other project skill.
 *
 * Target is `<project>/.agents/skills/<name>/`, which SKC's agents provider
 * loads on the project walk-up.
 */

import * as path from "node:path";
import { EXTERNAL_UI_SKILL_DEFINITIONS } from "../hooks/ui-skill-keywords";

export type ExternalUiSkillStatus = "installed" | "already-present" | "failed" | "missing";

export interface ExternalUiSkillResult {
	skill: string;
	source: string;
	status: ExternalUiSkillStatus;
	path: string;
	detail?: string;
}

export interface ExternalUiSkillsReport {
	projectDir: string;
	installed: number;
	alreadyPresent: number;
	failed: number;
	missing: number;
	skills: ExternalUiSkillResult[];
}

export interface InstallExternalUiSkillsOptions {
	cwd: string;
	/** Report what would happen without running any installer. */
	check?: boolean;
	/** Reinstall even when the skill is already present. */
	force?: boolean;
}

function installedSkillPath(cwd: string, skill: string): string {
	return path.join(cwd, ".agents", "skills", skill, "SKILL.md");
}

export async function installExternalUiSkills(
	options: InstallExternalUiSkillsOptions,
): Promise<ExternalUiSkillsReport> {
	const cwd = path.resolve(options.cwd);
	const skills: ExternalUiSkillResult[] = [];

	for (const definition of EXTERNAL_UI_SKILL_DEFINITIONS) {
		const target = installedSkillPath(cwd, definition.skill);
		const present = await Bun.file(target).exists();

		if (present && !options.force) {
			skills.push({ skill: definition.skill, source: definition.source, status: "already-present", path: target });
			continue;
		}
		if (options.check) {
			skills.push({
				skill: definition.skill,
				source: definition.source,
				status: "missing",
				path: target,
				detail: definition.installCommand,
			});
			continue;
		}

		// Upstream's own publisher CLI. SKC never republishes the payload; it only
		// runs the documented install into the user's project.
		const proc = Bun.spawn(["sh", "-c", definition.installCommand], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		const landed = await Bun.file(target).exists();

		if (exitCode === 0 && landed) {
			skills.push({ skill: definition.skill, source: definition.source, status: "installed", path: target });
			continue;
		}
		skills.push({
			skill: definition.skill,
			source: definition.source,
			status: "failed",
			path: target,
			detail:
				exitCode !== 0
					? `installer exited ${exitCode}: ${stderr.trim().split("\n").at(-1) ?? "no output"}`
					: "installer reported success but no SKILL.md landed",
		});
	}

	return {
		projectDir: cwd,
		installed: skills.filter(entry => entry.status === "installed").length,
		alreadyPresent: skills.filter(entry => entry.status === "already-present").length,
		failed: skills.filter(entry => entry.status === "failed").length,
		missing: skills.filter(entry => entry.status === "missing").length,
		skills,
	};
}

export function formatExternalUiSkillsReport(report: ExternalUiSkillsReport): string {
	const lines: string[] = [];
	for (const entry of report.skills) {
		const relative = path.relative(report.projectDir, entry.path) || entry.path;
		switch (entry.status) {
			case "installed":
				lines.push(`installed ${entry.skill} -> ${relative}`);
				break;
			case "already-present":
				lines.push(`present   ${entry.skill} -> ${relative}`);
				break;
			case "missing":
				lines.push(`missing   ${entry.skill} (run: ${entry.detail})`);
				break;
			case "failed":
				lines.push(`failed    ${entry.skill}: ${entry.detail}`);
				break;
		}
	}
	lines.push(
		`${report.installed} installed, ${report.alreadyPresent} already present, ${report.missing} missing, ${report.failed} failed.`,
	);
	return lines.join("\n");
}
