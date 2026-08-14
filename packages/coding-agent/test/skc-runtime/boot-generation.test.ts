import { describe, expect, it } from "bun:test";
import {
	type BootGeneration,
	compareBootGeneration,
	parseDarwinBootTime,
	parseLinuxBootId,
	parseLinuxProcBtime,
	readBootGeneration,
	recordBootGeneration,
} from "../../src/skc-runtime/boot-generation";

const DARWIN_RAW = "{ sec = 1785305532, usec = 377197 } Wed Jul 29 15:12:12 2026\n";
const BOOT_ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

describe("boot value parsers", () => {
	it("reads darwin kern.boottime down to microseconds", () => {
		expect(parseDarwinBootTime(DARWIN_RAW)).toBe("1785305532.377197");
		// Microseconds are padded so string equality cannot be fooled by width.
		expect(parseDarwinBootTime("{ sec = 100, usec = 7 }")).toBe("100.000007");
		expect(parseDarwinBootTime("garbage")).toBeNull();
	});

	it("accepts only a real boot id", () => {
		expect(parseLinuxBootId(`${BOOT_ID}\n`)).toBe(BOOT_ID);
		expect(parseLinuxBootId("not-a-uuid")).toBeNull();
		expect(parseLinuxBootId("")).toBeNull();
	});

	it("extracts btime from /proc/stat", () => {
		expect(parseLinuxProcBtime("cpu 1 2 3\nbtime 1700000000\nprocesses 42\n")).toBe("1700000000");
		expect(parseLinuxProcBtime("cpu 1 2 3\nprocesses 42\n")).toBeNull();
	});
});

describe("readBootGeneration", () => {
	it("prefers the linux boot id and falls back to /proc/stat btime", () => {
		expect(
			readBootGeneration({
				platform: "linux",
				readFile: file => (file.endsWith("boot_id") ? BOOT_ID : "btime 1700000000\n"),
			}),
		).toEqual({ source: "linux-boot-id", value: BOOT_ID });

		expect(
			readBootGeneration({
				platform: "linux",
				readFile: file => {
					if (file.endsWith("boot_id")) throw new Error("EACCES");
					return "btime 1700000000\n";
				},
			}),
		).toEqual({ source: "linux-proc-btime", value: "1700000000" });
	});

	it("reports unavailable rather than guessing when every probe fails", () => {
		expect(
			readBootGeneration({
				platform: "linux",
				readFile: () => {
					throw new Error("EACCES");
				},
			}),
		).toEqual({ source: "unavailable", value: null });

		expect(
			readBootGeneration({
				platform: "darwin",
				runCommand: () => ({ exitCode: 1, stdout: "" }),
			}),
		).toEqual({ source: "unavailable", value: null });
	});

	it("is unavailable on win32, where restore is unsupported anyway", () => {
		expect(readBootGeneration({ platform: "win32" })).toEqual({ source: "unavailable", value: null });
	});

	it("reads the real host without throwing", () => {
		const current = readBootGeneration();
		if (process.platform === "darwin" || process.platform === "linux") {
			expect(current.source).not.toBe("unavailable");
			expect(current.value).toBeTruthy();
		}
	});
});

describe("compareBootGeneration", () => {
	const darwin = (value: string): BootGeneration => ({ source: "darwin-kern-boottime", value });

	it("only a same-source difference is executable", () => {
		const recorded = recordBootGeneration(darwin("1.000001"));
		expect(recorded).toEqual({ schema_version: 1, source: "darwin-kern-boottime", value: "1.000001" });
		expect(compareBootGeneration(recorded, darwin("2.000002"))).toBe("changed");
		expect(compareBootGeneration(recorded, darwin("1.000001"))).toBe("same_boot");
	});

	it("never reads a source change as a reboot", () => {
		// Linux can record boot-id and later fall back to proc-btime. Those values
		// are always unequal on one boot, so treating this as `changed` would
		// duplicate every live session.
		const recorded = { schema_version: 1, source: "linux-boot-id", value: BOOT_ID };
		expect(compareBootGeneration(recorded, { source: "linux-proc-btime", value: "1700000000" })).toBe("boot_unknown");
	});

	it("is unknown when the record is missing, malformed, or unusable", () => {
		const current = darwin("1.000001");
		expect(compareBootGeneration(undefined, current)).toBe("boot_unknown");
		expect(compareBootGeneration(null, current)).toBe("boot_unknown");
		expect(compareBootGeneration({}, current)).toBe("boot_unknown");
		expect(compareBootGeneration({ schema_version: 2, source: "darwin-kern-boottime", value: "x" }, current)).toBe(
			"boot_unknown",
		);
		expect(compareBootGeneration({ schema_version: 1, source: "darwin-kern-boottime", value: "" }, current)).toBe(
			"boot_unknown",
		);
		// A record must never claim the unavailable source.
		expect(compareBootGeneration({ schema_version: 1, source: "unavailable", value: "x" }, current)).toBe(
			"boot_unknown",
		);
	});

	it("is unknown when the current probe cannot answer", () => {
		const recorded = recordBootGeneration(darwin("1.000001"));
		expect(compareBootGeneration(recorded, { source: "unavailable", value: null })).toBe("boot_unknown");
		expect(compareBootGeneration(recorded, { source: "darwin-kern-boottime", value: null })).toBe("boot_unknown");
	});

	it("refuses to record an unusable current value", () => {
		expect(recordBootGeneration({ source: "unavailable", value: null })).toBeNull();
		expect(recordBootGeneration({ source: "darwin-kern-boottime", value: null })).toBeNull();
	});
});
