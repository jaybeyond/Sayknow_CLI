import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatExternalUiSkillsReport,
	installExternalUiSkills,
} from "@sayknow-cli/coding-agent/setup/external-ui-skills";

const roots: string[] = [];

async function makeProject(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-external-ui-skills-"));
	roots.push(root);
	return root;
}

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("external UI skill setup", () => {
	it("reports a missing skill with its install command without running anything", async () => {
		const cwd = await makeProject();
		const report = await installExternalUiSkills({ cwd, check: true });

		expect(report.missing).toBe(1);
		expect(report.installed).toBe(0);
		const entry = report.skills.find(skill => skill.skill === "transitions-dev");
		expect(entry?.status).toBe("missing");
		expect(entry?.detail).toContain("skills@latest add Jakubantalik/transitions.dev");
		// --check must not touch the filesystem.
		expect(await Bun.file(path.join(cwd, ".agents", "skills", "transitions-dev", "SKILL.md")).exists()).toBe(false);
	});

	it("treats an already-installed skill as present and does not reinstall", async () => {
		const cwd = await makeProject();
		const target = path.join(cwd, ".agents", "skills", "transitions-dev");
		await fs.mkdir(target, { recursive: true });
		await Bun.write(path.join(target, "SKILL.md"), "---\nname: transitions-dev\n---\n");

		const report = await installExternalUiSkills({ cwd });
		expect(report.alreadyPresent).toBe(1);
		expect(report.installed).toBe(0);
		expect(report.failed).toBe(0);
		// Untouched: a reinstall would overwrite this sentinel body.
		expect(await Bun.file(path.join(target, "SKILL.md")).text()).toContain("name: transitions-dev");
	});

	it("targets the project root SKC's agents provider loads", async () => {
		const cwd = await makeProject();
		const report = await installExternalUiSkills({ cwd, check: true });
		const entry = report.skills[0]!;
		expect(path.relative(cwd, entry.path)).toBe(path.join(".agents", "skills", "transitions-dev", "SKILL.md"));
	});

	it("renders an actionable report", async () => {
		const cwd = await makeProject();
		const rendered = formatExternalUiSkillsReport(await installExternalUiSkills({ cwd, check: true }));
		expect(rendered).toContain("missing   transitions-dev");
		expect(rendered).toContain("0 installed, 0 already present, 1 missing, 0 failed.");
	});
});
