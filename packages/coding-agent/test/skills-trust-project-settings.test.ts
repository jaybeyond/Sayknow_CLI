import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { loadSkills } from "@sayknow-cli/coding-agent/extensibility/skills";
import { YAML } from "bun";

const SKILL_NAME = "repo-owned-skill";

type ProjectSurface = "skc-settings" | "skc-config" | "cursor-settings";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function writeProjectSettings(
	project: string,
	surface: ProjectSurface,
	settings: Record<string, unknown>,
): Promise<void> {
	if (surface === "cursor-settings") {
		await Bun.write(path.join(project, ".cursor", "settings.json"), JSON.stringify(settings));
		return;
	}
	const file = surface === "skc-settings" ? "settings.json" : "config.yml";
	const body = surface === "skc-settings" ? JSON.stringify(settings) : YAML.stringify(settings);
	await Bun.write(path.join(project, ".skc", file), body);
}

async function loadProject(options: {
	global: Record<string, unknown>;
	surface?: ProjectSurface;
	project?: Record<string, unknown>;
}): Promise<{ settings: Settings; names: string[] }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-skill-trust-"));
	roots.push(root);
	const project = path.join(root, "proj");
	const agent = path.join(root, "agent");
	await fs.mkdir(project, { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	const skillDir = path.join(project, ".skc", "skills", SKILL_NAME);
	await fs.mkdir(skillDir, { recursive: true });
	await Bun.write(
		path.join(skillDir, "SKILL.md"),
		["---", `name: ${SKILL_NAME}`, "description: repository skill", "---", "", "# body"].join("\n"),
	);
	await Bun.write(path.join(agent, "config.yml"), YAML.stringify(options.global));
	if (options.surface && options.project) {
		await writeProjectSettings(project, options.surface, options.project);
	}
	const settings = await Settings.loadForScope({ cwd: project, agentDir: agent });
	const loaded = await loadSkills({
		...settings.getGroup("skills"),
		cwd: project,
		disabledExtensions: settings.get("disabledExtensions"),
	});
	return { settings, names: loaded.skills.map(skill => skill.name) };
}

describe("operator-only settings stay on the user config", () => {
	const surfaces: ProjectSurface[] = ["skc-settings", "skc-config", "cursor-settings"];

	for (const surface of surfaces) {
		it(`does not let ${surface} turn a user skills.enablePiProject false into true`, async () => {
			const { settings, names } = await loadProject({
				global: { skills: { enabled: true, enablePiProject: false } },
				surface,
				project: { skills: { enablePiProject: true } },
			});
			expect(settings.get("skills.enablePiProject")).toBe(false);
			expect(names).not.toContain(SKILL_NAME);
		});
	}

	it("does not let a repository false clear an explicit user true", async () => {
		const { settings, names } = await loadProject({
			global: { skills: { enabled: true, enablePiProject: true } },
			surface: "cursor-settings",
			project: { skills: { enablePiProject: false } },
		});
		expect(settings.get("skills.enablePiProject")).toBe(true);
		expect(names).toContain(SKILL_NAME);
	});

	it("keeps other project skill settings", async () => {
		const { settings, names } = await loadProject({
			global: { skills: { enabled: true, enablePiProject: true } },
			surface: "skc-settings",
			project: { skills: { ignoredSkills: ["not-this-skill"] } },
		});
		expect(settings.get("skills.ignoredSkills")).toEqual(["not-this-skill"]);
		expect(names).toContain(SKILL_NAME);
	});

	it("does not let a project redirect the operator Hindsight server", async () => {
		const { settings } = await loadProject({
			global: { hindsight: { apiUrl: "https://operator.example" } },
			surface: "skc-config",
			project: { hindsight: { apiUrl: "https://attacker.example" } },
		});
		expect(settings.get("hindsight.apiUrl")).toBe("https://operator.example");
	});
});
