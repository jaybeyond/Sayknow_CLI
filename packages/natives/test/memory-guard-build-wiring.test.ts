import { describe, expect, it } from "bun:test";
import { assertRequiredSymbols, missingRequiredFunctions } from "../scripts/embed-guard";

describe("memory-guard native build wiring", () => {
	it("rejects generated bindings that omit the Windows memory probe", () => {
		expect(() =>
			assertRequiredSymbols("export function nativeBuildInfo(): unknown;", [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
			]),
		).toThrow("probeWindowsJobMemory");
	});

	it("rejects native addons that omit the Windows memory probe", () => {
		expect(
			missingRequiredFunctions({ nativeBuildInfo: () => ({}) }, ["nativeBuildInfo", "probeWindowsJobMemory"]),
		).toEqual(["probeWindowsJobMemory"]);
		expect(
			missingRequiredFunctions({ nativeBuildInfo: () => ({}), probeWindowsJobMemory: () => ({}) }, [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
			]),
		).toEqual([]);
	});
});
