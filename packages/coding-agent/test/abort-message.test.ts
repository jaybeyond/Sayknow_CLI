import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildAbortDisplayMessage } from "@sayknow-cli/coding-agent/modes/utils/abort-message";

describe("buildAbortDisplayMessage", () => {
	const idleEnv = [
		"SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
		"PI_STREAM_IDLE_TIMEOUT_MS",
		"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	];
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const name of idleEnv) {
			saved.set(name, Bun.env[name]);
			delete Bun.env[name];
		}
	});
	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	});

	it("keeps the legacy generic abort labels when there is no useful cause", () => {
		expect(buildAbortDisplayMessage({ errorMessage: undefined, retryAttempt: 0 })).toBe("Operation aborted");
		expect(buildAbortDisplayMessage({ errorMessage: "Request was aborted", retryAttempt: 1 })).toBe(
			"Aborted after 1 retry attempt",
		);
		expect(buildAbortDisplayMessage({ errorMessage: "Request was aborted.", retryAttempt: 2 })).toBe(
			"Aborted after 2 retry attempts",
		);
	});

	it("preserves the provider root cause after retries", () => {
		expect(buildAbortDisplayMessage({ errorMessage: "fetch failed", retryAttempt: 1 })).toBe(
			"Aborted after 1 retry attempt: fetch failed",
		);
	});

	it("adds a remediation hint for provider stream idle watchdog aborts", () => {
		expect(
			buildAbortDisplayMessage({
				errorMessage: "Anthropic stream stalled while waiting for the next event",
				retryAttempt: 1,
			}),
		).toBe(
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=600000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.",
		);
	});

	it("always suggests a window longer than the one that just fired", () => {
		const hint = (errorMessage: string) =>
			/PI_STREAM_IDLE_TIMEOUT_MS=(\d+) for/.exec(buildAbortDisplayMessage({ errorMessage, retryAttempt: 1 }))?.[1];
		const stall = "Anthropic stream stalled while waiting for the next event";
		// Anthropic's built-in window is 300000: suggesting it again would change nothing.
		expect(Number(hint(stall))).toBeGreaterThan(300_000);
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "900000";
		expect(hint(stall)).toBe("1800000");
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "60000";
		expect(hint(stall)).toBe("600000");
	});

	it("is idempotent for replayed abort display labels without retry context", () => {
		const formatted =
			"Aborted after 1 retry attempt: Anthropic stream stalled while waiting for the next event. Hint: set PI_STREAM_IDLE_TIMEOUT_MS=600000 for slow reasoning/proxy streams, or PI_STREAM_IDLE_TIMEOUT_MS=0 to disable the watchdog.";
		expect(buildAbortDisplayMessage({ errorMessage: formatted, retryAttempt: 0 })).toBe(formatted);
		expect(buildAbortDisplayMessage({ errorMessage: "Operation aborted: fetch failed", retryAttempt: 0 })).toBe(
			"Operation aborted: fetch failed",
		);
	});
});
