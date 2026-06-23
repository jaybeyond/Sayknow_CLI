import { describe, expect, test } from "bun:test";
import { parseInThreadConfigCommand } from "../src/notifications/config-commands";

describe("parseInThreadConfigCommand", () => {
	test("/verbose and /lean toggle verbosity", () => {
		expect(parseInThreadConfigCommand("/verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/lean")).toEqual({ verbosity: "lean" });
	});

	test("/verbosity <arg> sets verbosity, rejects bad args", () => {
		expect(parseInThreadConfigCommand("/verbosity verbose")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/verbosity lean")).toEqual({ verbosity: "lean" });
		expect(parseInThreadConfigCommand("/verbosity loud")).toBeUndefined();
	});

	test("/redact on|off|true|false|1|0 toggles redaction", () => {
		expect(parseInThreadConfigCommand("/redact on")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact off")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact true")).toEqual({ redact: true });
		expect(parseInThreadConfigCommand("/redact 0")).toEqual({ redact: false });
		expect(parseInThreadConfigCommand("/redact maybe")).toBeUndefined();
	});

	test("non-commands and free text return undefined (treated as injection)", () => {
		expect(parseInThreadConfigCommand("keep going")).toBeUndefined();
		expect(parseInThreadConfigCommand("/answer s1 yes")).toBeUndefined();
		expect(parseInThreadConfigCommand("/unknown")).toBeUndefined();
		expect(parseInThreadConfigCommand("")).toBeUndefined();
	});

	test("is case-insensitive and tolerant of extra whitespace", () => {
		expect(parseInThreadConfigCommand("  /VERBOSE  ")).toEqual({ verbosity: "verbose" });
		expect(parseInThreadConfigCommand("/Redact   ON")).toEqual({ redact: true });
	});
});
