import { describe, expect, it } from "bun:test";
import {
	buildMallocReexecArgv,
	formatMallocEnvNotice,
	hasMacOSMallocEnv,
	MALLOC_ENV_REEXEC_GUARD,
	macOSMallocEnvNames,
	shouldReexecForMacOSMallocEnv,
} from "./malloc-env-guard";

describe("hasMacOSMallocEnv", () => {
	it("detects MallocStackLogging", () => {
		expect(hasMacOSMallocEnv({ MallocStackLogging: "0" })).toBe(true);
	});

	it("detects MallocStackLoggingNoCompact", () => {
		expect(hasMacOSMallocEnv({ MallocStackLoggingNoCompact: "1" })).toBe(true);
	});

	// libmalloc enables stack logging for these too; matching only the two
	// classic names let a contaminated launch skip the re-exec.
	it("detects MallocStackLoggingLite and MallocStackLoggingDirectory", () => {
		expect(hasMacOSMallocEnv({ MallocStackLoggingLite: "1" })).toBe(true);
		expect(hasMacOSMallocEnv({ MallocStackLoggingDirectory: "/tmp" })).toBe(true);
	});

	it("is false when no MallocStackLogging* var is present", () => {
		expect(hasMacOSMallocEnv({ PATH: "/usr/bin", HOME: "/home/x", MallocNanoZone: "1" })).toBe(false);
	});

	it("ignores a malloc var whose value is undefined", () => {
		expect(hasMacOSMallocEnv({ MallocStackLogging: undefined })).toBe(false);
	});

	it("is false for an empty environment", () => {
		expect(hasMacOSMallocEnv({})).toBe(false);
	});
});

describe("shouldReexecForMacOSMallocEnv", () => {
	it("is true on darwin with a malloc var and no loop guard", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "darwin")).toBe(true);
	});

	it("is false off darwin even when a malloc var is present", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "linux")).toBe(false);
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0" }, "win32")).toBe(false);
	});

	it("is false when the loop guard is already set (already re-exec'd)", () => {
		expect(shouldReexecForMacOSMallocEnv({ MallocStackLogging: "0", [MALLOC_ENV_REEXEC_GUARD]: "1" }, "darwin")).toBe(
			false,
		);
	});

	it("is false on darwin when no malloc var is present", () => {
		expect(shouldReexecForMacOSMallocEnv({ PATH: "/usr/bin" }, "darwin")).toBe(false);
	});
});

describe("buildMallocReexecArgv", () => {
	it("drops the embedded virtual entry for a POSIX compiled binary", () => {
		expect(buildMallocReexecArgv(["/exe", "/$bunfs/root/cli", "run", "--flag"], "/exe")).toEqual([
			"/exe",
			"run",
			"--flag",
		]);
	});

	it("drops the embedded virtual entry for a Windows compiled binary", () => {
		expect(buildMallocReexecArgv(["C:/exe.exe", "B:\\~BUN\\root\\cli", "run"], "C:/exe.exe")).toEqual([
			"C:/exe.exe",
			"run",
		]);
	});

	it("drops the percent-encoded embedded virtual entry", () => {
		expect(buildMallocReexecArgv(["/exe", "B:\\%7EBUN\\root\\cli", "run"], "/exe")).toEqual(["/exe", "run"]);
	});

	it("keeps the on-disk script for a source/dev-link run", () => {
		expect(
			buildMallocReexecArgv(["/usr/bin/bun", "/repo/packages/coding-agent/src/cli.ts", "run", "-x"], "/usr/bin/bun"),
		).toEqual(["/usr/bin/bun", "/repo/packages/coding-agent/src/cli.ts", "run", "-x"]);
	});

	it("handles a source run with no user args", () => {
		expect(buildMallocReexecArgv(["/usr/bin/bun", "/repo/cli.ts"], "/usr/bin/bun")).toEqual([
			"/usr/bin/bun",
			"/repo/cli.ts",
		]);
	});
});

describe("macOSMallocEnvNames", () => {
	it("returns only the MallocStackLogging* names, sorted", () => {
		expect(
			macOSMallocEnvNames({
				PATH: "/usr/bin",
				MallocStackLoggingNoCompact: "1",
				MallocNanoZone: "1",
				MallocStackLogging: "0",
			}),
		).toEqual(["MallocStackLogging", "MallocStackLoggingNoCompact"]);
	});
});

describe("formatMallocEnvNotice", () => {
	it("names every detected var and its permanent launchctl fix", () => {
		const notice = formatMallocEnvNotice(["MallocStackLogging", "MallocStackLoggingLite"]);
		expect(notice).toContain("(MallocStackLogging, MallocStackLoggingLite)");
		expect(notice).toContain("unset MallocStackLogging MallocStackLoggingLite\n");
		expect(notice).toContain("launchctl unsetenv MallocStackLogging\n");
		expect(notice).toContain("launchctl unsetenv MallocStackLoggingLite\n");
		expect(notice).not.toContain("MallocStackLoggingNoCompact");
	});
});
