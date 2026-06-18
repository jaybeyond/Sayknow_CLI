import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@sayknow-cli/coding-agent/capability/types";
import { getConfigDirs } from "@sayknow-cli/coding-agent/config";
import { getUserPath } from "@sayknow-cli/coding-agent/discovery/helpers";

describe("PI_CONFIG_DIR", () => {
	const original = process.env.PI_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = original;
		}
	});

	test("getUserPath uses PI_CONFIG_DIR for native userAgent", () => {
		process.env.PI_CONFIG_DIR = ".config/skc";
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		const result = getUserPath(ctx, "native", "commands");
		expect(result).toBe(path.join(ctx.home, ".config/skc/agent", "commands"));
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		process.env.PI_CONFIG_DIR = ".config/skc";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/skc", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".skc", level: "user" });
	});
	test("getConfigDirs excludes Claude and Codex config roots", () => {
		const userDirs = getConfigDirs("", { project: false }).map(entry => entry.source);
		const projectDirs = getConfigDirs("", { user: false, project: true, cwd: "/work/project" }).map(
			entry => entry.source,
		);

		expect(userDirs).not.toContain(".claude");
		expect(userDirs).not.toContain(".codex");
		expect(projectDirs).not.toContain(".claude");
		expect(projectDirs).not.toContain(".codex");
	});
});
