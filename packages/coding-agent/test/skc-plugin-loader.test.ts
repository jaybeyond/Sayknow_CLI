import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	discoverSkcPluginRoots,
	loadSkcPlugin,
	loadSkcPlugins,
	SkcPluginLoadError,
	type SkcPluginLoadErrorCode,
} from "../src/extensibility/skc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "skc-plugins");
const tempRoots: string[] = [];

async function copyFixtureToProject(fixtureName: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-plugin-loader-"));
	tempRoots.push(cwd);
	const pluginsDir = path.join(cwd, ".skc", "skc-plugins");
	await fs.mkdir(pluginsDir, { recursive: true });
	await fs.cp(path.join(fixturesRoot, fixtureName), path.join(pluginsDir, fixtureName), { recursive: true });
	return cwd;
}

async function expectLoadError(root: string, code: SkcPluginLoadErrorCode): Promise<void> {
	try {
		await loadSkcPlugin(root);
	} catch (error) {
		expect(error).toBeInstanceOf(SkcPluginLoadError);
		expect((error as SkcPluginLoadError).code).toBe(code);
		return;
	}
	throw new Error(`Expected ${code} load error`);
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("SKC plugin loader", () => {
	test("loads valid skill and agent plugin fixtures", async () => {
		const skill = await loadSkcPlugin(path.join(fixturesRoot, "valid-skill-plugin"));
		expect(skill.name).toBe("valid-skill-plugin");
		expect(skill.bindings).toHaveLength(1);
		expect(skill.bindings[0]).toMatchObject({ parent: "ralplan", phase: "planner", activationArg: "design" });
		expect(skill.bindings[0].toolPaths).toHaveLength(2);
		expect(skill.toolBindings).toHaveLength(2);

		const agent = await loadSkcPlugin(path.join(fixturesRoot, "valid-agent-plugin"));
		expect(agent.bindings[0]).toMatchObject({ parent: "executor", phase: "prompt", activationArg: "domain" });

		const both = await loadSkcPlugins([
			path.join(fixturesRoot, "valid-skill-plugin"),
			path.join(fixturesRoot, "valid-agent-plugin"),
		]);
		expect(both.map(plugin => plugin.name)).toEqual(["valid-skill-plugin", "valid-agent-plugin"]);
	});

	test("rejects invalid fixtures with stable error codes", async () => {
		await expectLoadError(path.join(fixturesRoot, "invalid-parent"), "invalid_parent");
		await expectLoadError(path.join(fixturesRoot, "invalid-phase"), "invalid_phase");
		await expectLoadError(path.join(fixturesRoot, "duplicate-arg"), "duplicate_arg");
		await expectLoadError(path.join(fixturesRoot, "duplicate-parent-phase"), "duplicate_parent_phase");
		await expectLoadError(path.join(fixturesRoot, "invalid-forbidden-surface"), "forbidden_surface");
	});

	test("discovers direct and nested project SKC plugin roots", async () => {
		const directCwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-plugin-direct-"));
		tempRoots.push(directCwd);
		await fs.cp(path.join(fixturesRoot, "valid-skill-plugin"), path.join(directCwd, ".skc", "skc-plugins"), {
			recursive: true,
		});
		const directRoots = await discoverSkcPluginRoots({ cwd: directCwd });
		expect(directRoots).toContain(path.join(directCwd, ".skc", "skc-plugins"));

		const nestedCwd = await copyFixtureToProject("valid-agent-plugin");
		const nestedRoots = await discoverSkcPluginRoots({ cwd: nestedCwd });
		expect(nestedRoots).toContain(path.join(nestedCwd, ".skc", "skc-plugins", "valid-agent-plugin"));
	});
});
