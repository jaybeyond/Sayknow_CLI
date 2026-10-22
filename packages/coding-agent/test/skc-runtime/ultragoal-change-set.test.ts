import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	parseGitNameStatus,
	resolveGitBase,
	spawnText,
} from "@sayknow-cli/coding-agent/skc-runtime/ultragoal-change-set";

describe("ultragoal change-set extraction", () => {
	it("preserves rename paths and categories", () => {
		expect(parseGitNameStatus("R100\told.ts\tpackages/coding-agent/src/tools/computer.ts\n")).toEqual([
			{
				path: "packages/coding-agent/src/tools/computer.ts",
				oldPath: "old.ts",
				status: "renamed",
				category: "tool",
			},
		]);
	});
});

async function fixtureGit(root: string, ...args: string[]): Promise<string> {
	const result = await spawnText(
		["git", "-c", "user.name=SKC Test", "-c", "user.email=test@example.invalid", ...args],
		{ cwd: root },
	);
	if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function commitFixtureFile(root: string, name: string): Promise<void> {
	await Bun.write(path.join(root, name), `${name}\n`);
	await fixtureGit(root, "add", name);
	await fixtureGit(root, "commit", "-m", name);
}

async function withRepository(initialBranch: string, run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ultragoal-integration-base-"));
	try {
		await fixtureGit(root, "init", `--initial-branch=${initialBranch}`);
		await commitFixtureFile(root, "baseline.txt");
		await run(root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("ultragoal Git integration base resolution", () => {
	it("recognizes a develop integration branch", async () => {
		await withRepository("develop", async root => {
			await fixtureGit(root, "checkout", "-b", "feature");
			await commitFixtureFile(root, "feature.txt");
			expect(await resolveGitBase(root)).toBe("develop");
		});
	});

	for (const checkedOut of ["develop", "dev", "main"]) {
		it(`does not pick the checked-out ${checkedOut} as its own base`, async () => {
			await withRepository(checkedOut, async root => {
				// A distinct ancestor ref; the checked-out branch itself is always 0 ahead.
				await fixtureGit(root, "branch", "master");
				await commitFixtureFile(root, "change.txt");
				expect(await resolveGitBase(root)).toBe("master");
			});
		});
	}
});
