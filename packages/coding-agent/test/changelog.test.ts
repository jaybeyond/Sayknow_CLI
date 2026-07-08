import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@sayknow-cli/utils";
import {
	type ChangelogEntry,
	getDisplayChangelogEntries,
	getInstalledVersionChangelogEntry,
	parseChangelogContent,
} from "../src/utils/changelog";

const tempDirs: string[] = [];
function formatEntryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-changelog-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseChangelogContent", () => {
	it("returns entries newest first and ignores [Unreleased]", () => {
		const fixture = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [0.0.2] - 2024-01-02",
			"",
			"### Added",
			"",
			"- second entry",
			"",
			"## [0.0.1] - 2024-01-01",
			"",
			"### Added",
			"",
			"- first entry",
			"",
		].join("\n");

		const entries = parseChangelogContent(fixture);

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ major: 0, minor: 0, patch: 2 });
		expect(entries[0].content).toContain("second entry");
		expect(entries[1]).toMatchObject({ major: 0, minor: 0, patch: 1 });
		expect(entries[1].content).toContain("first entry");
	});

	it("returns no entries when no semver heading is present", () => {
		const fixture = ["# Changelog", "", "## [Unreleased]", "", "- pending", ""].join("\n");

		expect(parseChangelogContent(fixture)).toEqual([]);
	});
});

describe("getDisplayChangelogEntries", () => {
	it("returns the embedded coding-agent changelog newest entry first", () => {
		const entries = getDisplayChangelogEntries();

		expect(entries.length).toBeGreaterThanOrEqual(1);
		const top = entries[0]!;
		expect(top.content).toContain(`## [${formatEntryVersion(top)}]`);
	});

	it("ignores cwd and SKC_PACKAGE_DIR / PI_PACKAGE_DIR overrides for the displayed changelog", async () => {
		const tempDir = await makeTempDir();
		const decoyContent = [
			"# Changelog",
			"",
			"## [99.99.99] - 2099-01-01",
			"",
			"### Added",
			"",
			"- bogus stale entry from cwd",
			"",
		].join("\n");
		await fs.writeFile(path.join(tempDir, "CHANGELOG.md"), decoyContent);

		const originalCwd = process.cwd();
		const originalSkcPackageDir = process.env.SKC_PACKAGE_DIR;
		const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

		try {
			process.chdir(tempDir);
			process.env.SKC_PACKAGE_DIR = tempDir;
			process.env.PI_PACKAGE_DIR = tempDir;

			const entries = getDisplayChangelogEntries();

			expect(entries.length).toBeGreaterThanOrEqual(1);
			const top = entries[0]!;
			expect(formatEntryVersion(top)).not.toBe("99.99.99");
			expect(top.content).toContain(`## [${formatEntryVersion(top)}]`);
			expect(top.content).not.toContain("bogus stale entry from cwd");
		} finally {
			process.chdir(originalCwd);
			if (originalSkcPackageDir === undefined) delete process.env.SKC_PACKAGE_DIR;
			else process.env.SKC_PACKAGE_DIR = originalSkcPackageDir;
			if (originalPiPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
	});
});

describe("first-run changelog display", () => {
	it("uses the matching embedded entry or falls back to the newest entry on first launch", () => {
		const entries = getDisplayChangelogEntries();
		expect(entries.length).toBeGreaterThanOrEqual(2);

		const firstRunEntry = getInstalledVersionChangelogEntry(entries, VERSION);
		const matchingEntry = entries.find(entry => formatEntryVersion(entry) === VERSION);
		const olderVersion = entries.find(entry => entry !== (matchingEntry ?? entries[0]));

		expect(firstRunEntry).toBe(matchingEntry ?? entries[0]);
		expect(olderVersion).toBeDefined();

		if (matchingEntry) {
			expect(firstRunEntry!.content).toContain(`## [${VERSION}]`);
		}
		expect(firstRunEntry!.content).not.toContain(
			`## [${olderVersion!.major}.${olderVersion!.minor}.${olderVersion!.patch}]`,
		);
	});
});
