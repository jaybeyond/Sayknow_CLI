import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildReleaseBinaryUrlForTest,
	formatBinaryDownloadFailureMessageForTest,
	formatManualUpdateInstructionsForTest,
	formatVerificationFailureForTest,
	replaceBinaryForUpdate,
	resolveNpmManagedTargetForTest,
	resolveUpdateMethodForTest,
	runPackageManagerUpdateForTest,
} from "../src/cli/update-cli";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dir, "../../..");

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("update-cli install target detection", () => {
	it("uses bun update when prioritized skc is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/skc", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses binary update when prioritized skc is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/skc", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/skc", undefined);

		expect(method).toBe("binary");
	});

	it("detects a Windows npm wrapper shim and avoids one-file binary replacement", () => {
		const seenRoots: Array<{ packageName: string; packageRoot: string }> = [];
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\skc.cmd",
			"win32",
			(packageName, packageRoot) => {
				seenRoots.push({ packageName, packageRoot });
				return packageName === "sayknow-cli";
			},
		);

		expect(target).toEqual({ manager: "npm", packageName: "sayknow-cli" });
		expect(seenRoots[0]).toEqual({
			packageName: "sayknow-cli",
			packageRoot: "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\sayknow-cli",
		});
	});

	it("detects PowerShell npm wrapper shims so skc.ps1 is updated through npm too", () => {
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\skc.ps1",
			"win32",
			packageName => packageName === "sayknow-cli",
		);

		expect(target).toEqual({ manager: "npm", packageName: "sayknow-cli" });
	});

	it("does not classify missing Windows node_modules roots as npm-managed", () => {
		const target = resolveNpmManagedTargetForTest(
			"C:\\Users\\alice\\AppData\\Roaming\\npm\\skc.cmd",
			"win32",
			() => false,
		);

		expect(target).toBeUndefined();
	});

	it("keeps non-Windows package-manager-like shims on the existing bun/binary classifier", () => {
		const target = resolveNpmManagedTargetForTest("/usr/local/bin/skc", "linux", () => true);

		expect(target).toBeUndefined();
	});
});

describe("update-cli binary release assets", () => {
	it("downloads fallback binaries from the current owner release repository", () => {
		expect(buildReleaseBinaryUrlForTest("0.2.3", "linux", "x64")).toBe(
			"https://github.com/jaybeyond/Sayknow_CLI/releases/download/v0.2.3/skc-linux-x64",
		);
	});

	it("uses the existing Windows .exe release asset name", () => {
		expect(buildReleaseBinaryUrlForTest("0.2.3", "win32", "x64")).toBe(
			"https://github.com/jaybeyond/Sayknow_CLI/releases/download/v0.2.3/skc-windows-x64.exe",
		);
	});

	it("reports actionable Unix manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("linux");

		expect(instructions).toContain("bun install -g @sayknow-cli/coding-agent@latest");
		expect(instructions).toContain("npm, pnpm, or another package manager");
		expect(instructions).toContain(
			"curl -fsSL https://raw.githubusercontent.com/jaybeyond/Sayknow_CLI/main/scripts/install.sh | sh -s -- --binary",
		);
	});

	it("reports actionable Windows manual update commands for unsupported fallback paths", () => {
		const instructions = formatManualUpdateInstructionsForTest("win32");

		expect(instructions).toContain("bun install -g @sayknow-cli/coding-agent@latest");
		expect(instructions).toContain("npm, pnpm, or another package manager");
		expect(instructions).toContain(
			"irm https://raw.githubusercontent.com/jaybeyond/Sayknow_CLI/main/scripts/install.ps1 | iex",
		);
	});

	it("keeps manual reinstall guidance aligned with bundled installer repositories", async () => {
		const instructions = formatManualUpdateInstructionsForTest("linux");
		const shellInstaller = await Bun.file(path.join(repoRoot, "scripts/install.sh")).text();
		const windowsInstaller = await Bun.file(path.join(repoRoot, "scripts/install.ps1")).text();

		expect(instructions).toContain("raw.githubusercontent.com/jaybeyond/Sayknow_CLI/main/scripts/install.sh");
		expect(shellInstaller).toContain('REPO="jaybeyond/Sayknow_CLI"');
		expect(windowsInstaller).toContain('$Repo = "jaybeyond/Sayknow_CLI"');
		expect(formatManualUpdateInstructionsForTest("win32")).toContain(
			"raw.githubusercontent.com/jaybeyond/Sayknow_CLI/main/scripts/install.ps1",
		);
	});

	it("reports smoke-test failures as stale or partial update risk", () => {
		const message = formatVerificationFailureForTest(
			{
				ok: false,
				actual: "0.6.1",
				smokeTestFailed: true,
				smokeTestOutput: "native addon\nrelease\tmismatch",
			},
			"0.6.1",
		);

		expect(message).toContain("--smoke-test failed");
		expect(message).toContain("stale or partial update");
		expect(message).toContain("native addon release mismatch");
		expect(message).not.toContain("undefined");
	});

	it("includes actionable guidance when a release asset download fails", () => {
		const message = formatBinaryDownloadFailureMessageForTest(
			"skc-linux-x64",
			"https://github.com/jaybeyond/Sayknow_CLI/releases/download/v0.2.3/skc-linux-x64",
			"Not Found",
			"linux",
		);

		expect(message).toContain("Download failed for skc-linux-x64");
		expect(message).toContain("jaybeyond/Sayknow_CLI/releases/download/v0.2.3/skc-linux-x64");
		expect(message).toContain("bun install -g @sayknow-cli/coding-agent@latest");
	});

	it("includes actionable guidance when the platform has no release asset", () => {
		expect(() => buildReleaseBinaryUrlForTest("0.2.3", "freebsd", "x64")).toThrow(
			"bun install -g @sayknow-cli/coding-agent@latest",
		);
	});
});

describe("update-cli package-manager verification", () => {
	it("treats a nonzero bun install as successful when the installed runtime verifies", async () => {
		const warnings: string[] = [];
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(message => {
			warnings.push(String(message));
		});
		try {
			const result = await runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({
					exitCode: 1,
					text: () => 'Fail extracting tarball for "@sayknow-cli/natives"',
				}),
				verifyInstalledRuntime: async expectedVersion => ({
					ok: true,
					actual: expectedVersion,
					path: "/Users/test/.bun/bin/skc",
				}),
				printRecoveredVerification: () => {},
			});

			expect(result.ok).toBe(true);
			expect(result.actual).toBe("0.7.8");
			expect(warnings.join("\n")).toContain("bun exited with 1");
			expect(warnings.join("\n")).toContain("Treating the update as installed");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("keeps package-manager nonzero failures hard when runtime verification does not prove the update landed", async () => {
		await expect(
			runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({
					exitCode: 1,
					text: () => 'Fail extracting tarball for "@sayknow-cli/natives"',
				}),
				verifyInstalledRuntime: async () => ({
					ok: false,
					actual: "0.7.7",
					path: "/Users/test/.bun/bin/skc",
				}),
			}),
		).rejects.toThrow("Fail extracting tarball");
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous skc binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps a verified replacement when backup cleanup hits EPERM", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc.cmd");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");
		const originalUnlink = fsNode.promises.unlink;
		const unlinkSpy = vi.spyOn(fsNode.promises, "unlink").mockImplementation(async filePath => {
			if (String(filePath) === backupPath && fsNode.existsSync(backupPath)) {
				const err = new Error("EPERM: operation not permitted, unlink");
				(err as NodeJS.ErrnoException).code = "EPERM";
				throw err;
			}
			return await originalUnlink(filePath);
		});

		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});

			expect(result.ok).toBe(true);
			expect(result.cleanupWarning).toContain("Installed update, but could not remove backup file");
			expect(result.cleanupWarning).toContain(backupPath);
			expect(await Bun.file(targetPath).text()).toBe("new binary");
			expect(await Bun.file(tempPath).exists()).toBe(false);
			expect(await Bun.file(backupPath).text()).toBe("old binary");
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});
