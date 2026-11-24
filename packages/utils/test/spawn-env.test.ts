import { describe, expect, it } from "bun:test";
import { filterProcessEnv } from "../src/env";

describe("filterProcessEnv spawn hygiene", () => {
	it("drops every macOS MallocStackLogging* variable before spawning children", () => {
		expect(
			filterProcessEnv({
				MallocStackLogging: "0",
				MallocStackLoggingNoCompact: "0",
				MallocStackLoggingLite: "1",
				MallocStackLoggingDirectory: "/tmp",
				MallocNanoZone: "1",
				KEEP: "value",
			}),
		).toEqual({
			MallocNanoZone: "1",
			KEEP: "value",
		});
	});
});
