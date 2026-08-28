import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BinaryUpdateFlow } from "../src/cli/update-cli";
import {
	buildReleaseBinaryUrlForTest,
	fetchExpectedBinaryDigest,
	formatBinaryDownloadFailureMessageForTest,
	formatManualUpdateInstructionsForTest,
	formatVerificationFailureForTest,
	fsyncFileForTest,
	getBinaryNameForTest,
	replaceBinaryForUpdate,
	resolveNpmManagedTargetForTest,
	resolveUpdateMethodForTest,
	runBinaryUpdateFlow,
	runPackageManagerUpdateForTest,
	runUpdateCommand,
	verifyReleaseBinaryIntegrity,
	withBinaryUpdateLock,
} from "../src/cli/update-cli";
import { initTheme } from "../src/modes/theme/theme";

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
			"https://github.com/jaybeyond/Sayknow_CLI/releases/download/sayknow-v0.2.3/skc-linux-x64",
		);
	});

	it("uses the existing Windows .exe release asset name", () => {
		expect(buildReleaseBinaryUrlForTest("0.2.3", "win32", "x64")).toBe(
			"https://github.com/jaybeyond/Sayknow_CLI/releases/download/sayknow-v0.2.3/skc-windows-x64.exe",
		);
	});

	it("maps every published platform and rejects unsupported combinations", () => {
		expect(getBinaryNameForTest("linux", "x64")).toBe("skc-linux-x64");
		expect(getBinaryNameForTest("linux", "arm64")).toBe("skc-linux-arm64");
		expect(getBinaryNameForTest("darwin", "x64")).toBe("skc-darwin-x64");
		expect(getBinaryNameForTest("darwin", "arm64")).toBe("skc-darwin-arm64");
		expect(getBinaryNameForTest("win32", "x64")).toBe("skc-windows-x64.exe");
		expect(() => getBinaryNameForTest("win32", "arm64")).toThrow("Unsupported architecture");
	});

	it("resolves sums first, validates manifest fallback, and fails closed when both are missing", async () => {
		const digest = "a".repeat(64);
		const sumsFetch = async () => new Response(`${digest}  skc-linux-x64\n`);
		await expect(fetchExpectedBinaryDigest("1.2.3", "skc-linux-x64", sumsFetch)).resolves.toBe(digest);
		await expect(
			fetchExpectedBinaryDigest(
				"1.2.3",
				"skc-linux-x64",
				async () => new Response(`${digest}  skc-linux-x64\n${digest}  skc-linux-x64\n`),
			),
		).rejects.toThrow("more than once");

		const responses = [
			new Response("", { status: 404 }),
			Response.json({
				schema: "sayknow-release-binaries-v1",
				schema_version: 1,
				release_version: "1.2.3",
				tag: "sayknow-v1.2.3",
				binaries: [{ name: "skc-linux-x64", sha256: digest, size: 10 }],
			}),
		];
		await expect(fetchExpectedBinaryDigest("1.2.3", "skc-linux-x64", async () => responses.shift()!)).resolves.toBe(
			digest,
		);

		await expect(
			fetchExpectedBinaryDigest("1.2.3", "skc-linux-x64", async () => new Response("", { status: 404 })),
		).rejects.toThrow("no Sayknow binary integrity manifest");
	});

	it("rejects a downloaded binary with the wrong digest", async () => {
		const dir = await makeTempDir();
		const binary = path.join(dir, "skc");
		await Bun.write(binary, "downloaded bytes");
		await expect(
			verifyReleaseBinaryIntegrity(
				binary,
				"1.2.3",
				"skc-linux-x64",
				async () => new Response(`${"0".repeat(64)}  skc-linux-x64\n`),
			),
		).rejects.toThrow("SHA-256 mismatch");
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

	it("verifies a zero-exit install once and prints success and restart guidance once", async () => {
		await initTheme();
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		let verificationCalls = 0;
		try {
			const result = await runPackageManagerUpdateForTest({
				managerName: "bun",
				expectedVersion: "0.7.8",
				runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
				verifyInstalledRuntime: async expectedVersion => {
					verificationCalls += 1;
					return { ok: true, actual: expectedVersion, path: "/Users/test/.bun/bin/skc" };
				},
			});

			expect(result.ok).toBe(true);
			expect(verificationCalls).toBe(1);
			expect(output.filter(line => line.includes("Updated to 0.7.8"))).toHaveLength(1);
			expect(output.filter(line => line.includes("Restart skc to use the new version"))).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("rejects a zero-exit stale install with verification-specific diagnostics and no success output", async () => {
		const output: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		let verificationCalls = 0;
		try {
			await expect(
				runPackageManagerUpdateForTest({
					managerName: "bun",
					expectedVersion: "0.7.8",
					runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
					verifyInstalledRuntime: async () => {
						verificationCalls += 1;
						return { ok: false, actual: "0.7.7", path: "/Users/test/.bun/bin/skc" };
					},
				}),
			).rejects.toThrow("bun install exited successfully, but the selected skc runtime failed verification");
			expect(verificationCalls).toBe(1);
			expect(output.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to"))).toHaveLength(0);
			expect(output.filter(line => line.includes("Restart skc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
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

describe("update-cli command verification failures", () => {
	it("exits without refreshing defaults when a zero-exit install leaves a stale runtime", async () => {
		const output: string[] = [];
		const errors: string[] = [];
		const exitCodes: number[] = [];
		const sentinel = new Error("exit");
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			errors.push(String(message));
		});
		let verificationCalls = 0;
		let refreshCalls = 0;
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => ({ tag: "v999.0.0", version: "999.0.0" }),
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async (_target, expectedVersion) => {
							await runPackageManagerUpdateForTest({
								managerName: "bun",
								expectedVersion,
								runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
								verifyInstalledRuntime: async () => {
									verificationCalls += 1;
									return { ok: false, actual: "0.0.1", path: "/test/skc" };
								},
							});
						},
						refreshInstalledDefaultSkills: async () => {
							refreshCalls += 1;
						},
						exit: code => {
							exitCodes.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(verificationCalls).toBe(1);
			expect(exitCodes).toEqual([1]);
			expect(refreshCalls).toBe(0);
			expect(errors.join("\n")).toContain(
				"install exited successfully, but the selected skc runtime failed verification",
			);
			expect(errors.join("\n")).toContain("still reports 0.0.1 (expected 999.0.0)");
			expect(errors.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to") || line.includes("Restart skc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("exits without refreshing defaults when a zero-exit install fails its smoke test", async () => {
		const output: string[] = [];
		const errors: string[] = [];
		const exitCodes: number[] = [];
		const sentinel = new Error("exit");
		const logSpy = vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(message => {
			errors.push(String(message));
		});
		let verificationCalls = 0;
		let refreshCalls = 0;
		try {
			await expect(
				runUpdateCommand(
					{ force: false, check: false },
					{
						getLatestRelease: async () => ({ tag: "v999.0.0", version: "999.0.0" }),
						resolveUpdateTarget: async () => ({ method: "bun" }),
						performUpdate: async (_target, expectedVersion) => {
							await runPackageManagerUpdateForTest({
								managerName: "bun",
								expectedVersion,
								runInstall: async () => ({ exitCode: 0, text: () => "installed" }),
								verifyInstalledRuntime: async () => {
									verificationCalls += 1;
									return {
										ok: false,
										actual: "999.0.0",
										path: "/test/skc",
										smokeTestFailed: true,
										smokeTestOutput: "native addon mismatch",
									};
								},
							});
						},
						refreshInstalledDefaultSkills: async () => {
							refreshCalls += 1;
						},
						exit: code => {
							exitCodes.push(code);
							throw sentinel;
						},
					},
				),
			).rejects.toBe(sentinel);
			expect(verificationCalls).toBe(1);
			expect(exitCodes).toEqual([1]);
			expect(refreshCalls).toBe(0);
			expect(errors.join("\n")).toContain("--smoke-test failed");
			expect(errors.join("\n")).toContain("native addon mismatch");
			expect(errors.join("\n")).toContain(
				"install exited successfully, but the selected skc runtime failed verification",
			);
			expect(errors.join("\n")).not.toContain("install failed with exit code 0");
			expect(output.filter(line => line.includes("Updated to") || line.includes("Restart skc"))).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
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

	it("installs and verifies a binary when migrating to a fresh standalone target", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(tempPath, "new binary");

		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(result.ok).toBe(true);
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("recovers an interrupted backup before attempting the next replacement", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(backupPath, "last working binary");
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
		expect(await Bun.file(targetPath).text()).toBe("last working binary");
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("removes an unverified fresh-target publish recovered from a replacing journal", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "unverified interrupted publish");
		await Bun.write(`${backupPath}.state.json`, JSON.stringify({ phase: "replacing", hadTarget: false }));
		await Bun.write(tempPath, "broken next update");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.9",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow();
		expect(await Bun.file(targetPath).exists()).toBe(false);
		expect(await Bun.file(`${backupPath}.state.json`).exists()).toBe(false);
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

	it("does not mistake a committed cleanup warning for an interrupted rollback", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "verified binary");
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
			const first = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(first.cleanupWarning).toContain("could not remove backup");
		} finally {
			unlinkSpy.mockRestore();
		}

		await Bun.write(tempPath, "broken next update");
		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.9",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous skc binary");
		expect(await Bun.file(targetPath).text()).toBe("verified binary");
		expect(await Bun.file(backupPath).exists()).toBe(false);
		expect(await Bun.file(`${backupPath}.state.json`).exists()).toBe(false);
	});

	it("keeps the verified target when committed state cleanup fails", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		const statePath = `${backupPath}.state.json`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "verified binary");
		const originalUnlink = fsNode.promises.unlink;
		const unlinkSpy = vi.spyOn(fsNode.promises, "unlink").mockImplementation(async filePath => {
			if (String(filePath) === statePath && fsNode.existsSync(statePath)) {
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
			expect(result.cleanupWarning).toContain("could not remove transaction state file");
			expect(await Bun.file(targetPath).text()).toBe("verified binary");
			expect(await Bun.file(backupPath).exists()).toBe(false);
			expect(await Bun.file(statePath).exists()).toBe(true);
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

describe("update-cli download durability", () => {
	it("fsyncs a written file without altering its contents", async () => {
		const dir = await makeTempDir();
		const filePath = path.join(dir, "skc.new");
		await Bun.write(filePath, "downloaded binary bytes");

		await fsyncFileForTest(filePath);

		expect(await Bun.file(filePath).text()).toBe("downloaded binary bytes");
	});

	it("rejects when the target file does not exist", async () => {
		const dir = await makeTempDir();
		await expect(fsyncFileForTest(path.join(dir, "missing.new"))).rejects.toThrow();
	});

	it("closes the fsync file descriptor on success", async () => {
		const close = vi.fn(async () => {});
		const open = vi.spyOn(fsNode.promises, "open").mockResolvedValue({
			sync: async () => {},
			close,
		} as unknown as Awaited<ReturnType<typeof fsNode.promises.open>>);
		try {
			await fsyncFileForTest("/irrelevant/path");
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});

	it("closes the fsync file descriptor even when sync fails", async () => {
		const close = vi.fn(async () => {});
		const open = vi.spyOn(fsNode.promises, "open").mockResolvedValue({
			sync: async () => {
				throw new Error("EIO: sync failed");
			},
			close,
		} as unknown as Awaited<ReturnType<typeof fsNode.promises.open>>);
		try {
			await expect(fsyncFileForTest("/irrelevant/path")).rejects.toThrow("sync failed");
			expect(close).toHaveBeenCalledTimes(1);
		} finally {
			open.mockRestore();
		}
	});
});

describe("update-cli binary update locking", () => {
	it("serializes updater and installer transactions with the shared directory lock", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "skc");
		let release: (() => void) | undefined;
		const holding = withBinaryUpdateLock(
			targetPath,
			() =>
				new Promise<void>(resolve => {
					release = resolve;
				}),
		);
		while (!release) await Bun.sleep(1);

		await expect(withBinaryUpdateLock(targetPath, async () => {})).rejects.toThrow(
			"Another SKC installer or update is already running",
		);
		release();
		await holding;
		expect(await Bun.file(path.join(dir, ".skc-install.lock")).exists()).toBe(false);
	});
});

describe("update-cli binary update flow", () => {
	it("downloads, fsyncs, then replaces and verifies in that order", async () => {
		const calls: string[] = [];
		const targetPath = "/opt/skc/bin/skc";
		const flow: BinaryUpdateFlow = {
			transactionId: "test",
			download: async (url, tempPath) => {
				calls.push(`download ${url} -> ${tempPath}`);
			},
			verifyIntegrity: async filePath => {
				calls.push(`integrity ${filePath}`);
			},
			fsync: async filePath => {
				calls.push(`fsync ${filePath}`);
			},
			replace: async options => {
				calls.push(`replace ${options.tempPath} -> ${options.targetPath}`);
				return options.verifyInstalledVersion(options.expectedVersion);
			},
			verifyInstalledVersion: async expected => {
				calls.push(`verify ${expected}`);
				return { ok: true, actual: expected, path: targetPath };
			},
			removeTemp: async filePath => {
				calls.push(`removeTemp ${filePath}`);
			},
			beforeReplace: () => {
				calls.push("beforeReplace");
			},
		};

		const result = await runBinaryUpdateFlow(targetPath, "https://example.test/skc", "1.2.3", flow);

		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			`download https://example.test/skc -> ${targetPath}.new.test`,
			`integrity ${targetPath}.new.test`,
			`fsync ${targetPath}.new.test`,
			"beforeReplace",
			`replace ${targetPath}.new.test -> ${targetPath}`,
			"verify 1.2.3",
		]);
		expect(calls).not.toContain(`removeTemp ${targetPath}.new.test`);
	});

	it("removes the staged binary and never publishes when integrity verification fails", async () => {
		const calls: string[] = [];
		const targetPath = "/opt/skc/bin/skc";
		await expect(
			runBinaryUpdateFlow(targetPath, "https://example.test/skc", "1.2.3", {
				transactionId: "test",
				download: async () => {
					calls.push("download");
				},
				verifyIntegrity: async () => {
					calls.push("integrity");
					throw new Error("SHA-256 mismatch");
				},
				fsync: async () => {
					calls.push("fsync");
				},
				replace: async () => {
					calls.push("replace");
					return { ok: true };
				},
				verifyInstalledVersion: async () => ({ ok: true }),
				removeTemp: async () => {
					calls.push("removeTemp");
				},
			}),
		).rejects.toThrow("SHA-256 mismatch");
		expect(calls).toEqual(["download", "integrity", "removeTemp"]);
	});

	it("aborts before replacement/verification when fsync fails", async () => {
		const calls: string[] = [];
		const targetPath = "/opt/skc/bin/skc";
		const flow: BinaryUpdateFlow = {
			transactionId: "test",
			download: async (_url, tempPath) => {
				calls.push(`download ${tempPath}`);
			},
			verifyIntegrity: async () => {},
			fsync: async () => {
				calls.push("fsync");
				throw new Error("EIO: fsync failed");
			},
			replace: async () => {
				calls.push("replace");
				return { ok: true };
			},
			verifyInstalledVersion: async () => {
				calls.push("verify");
				return { ok: true };
			},
			removeTemp: async filePath => {
				calls.push(`removeTemp ${filePath}`);
			},
		};

		await expect(runBinaryUpdateFlow(targetPath, "https://example.test/skc", "1.2.3", flow)).rejects.toThrow(
			"fsync failed",
		);

		expect(calls).toEqual([`download ${targetPath}.new.test`, "fsync", `removeTemp ${targetPath}.new.test`]);
		expect(calls).not.toContain("replace");
		expect(calls).not.toContain("verify");
	});
});
