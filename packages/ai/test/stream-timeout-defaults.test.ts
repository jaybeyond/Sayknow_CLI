import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	carryCodexStreamTimeoutPolicy,
	getOpenAIStreamIdleTimeoutMs,
	getProviderFirstEventTimeoutFallbackMs,
	getProviderStreamIdleTimeoutFallbackMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	resolveCodexStreamTimeoutPolicy,
	takeCodexStreamTimeoutPolicy,
} from "../src/utils/idle-iterator";

/**
 * Per-provider fallback overrides on the stream-watchdog helpers.
 *
 * These helpers let selected slow-first-token providers widen their first-event
 * floor beyond the 100s global default without forcing every provider to wait
 * just as long. Tests pin the precedence contract callers depend on:
 * caller option > env var > per-provider fallback > base default.
 */

const ENV_KEYS = [
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = originalEnv[key];
		if (prior === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = prior;
		}
	}
});

describe("getProviderFirstEventTimeoutFallbackMs(provider)", () => {
	it("gives Kimi Code one continuous 300-second first-event window", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("kimi-code")).toBe(300_000);
	});

	it("does not widen unrelated providers", () => {
		expect(getProviderFirstEventTimeoutFallbackMs("anthropic")).toBeUndefined();
	});
});

describe("getProviderStreamIdleTimeoutFallbackMs(provider)", () => {
	it("gives Anthropic a 300-second idle window for silent thinking blocks", () => {
		expect(getProviderStreamIdleTimeoutFallbackMs("anthropic")).toBe(300_000);
		expect(getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs("anthropic"))).toBe(300_000);
	});

	it("keeps the shared 120-second default for other providers", () => {
		expect(getProviderStreamIdleTimeoutFallbackMs("openai")).toBeUndefined();
		expect(getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs("openai"))).toBe(120_000);
	});

	it("still lets the env override and disable the Anthropic window", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "45000";
		expect(getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs("anthropic"))).toBe(45_000);
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(getProviderStreamIdleTimeoutFallbackMs("anthropic"))).toBeUndefined();
	});
});
describe("getStreamIdleTimeoutMs(fallbackMs)", () => {
	it("returns the per-provider fallback when env vars are unset", () => {
		expect(getStreamIdleTimeoutMs(300_000)).toBe(300_000);
	});

	it("lets PI_STREAM_IDLE_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});

	it("treats PI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});

	it("honors the documented SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS override", () => {
		Bun.env.SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "77";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(77);
	});

	it("resolves SKC-first: SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS wins over legacy PI_STREAM_IDLE_TIMEOUT_MS", () => {
		Bun.env.SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "77";
		Bun.env.PI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(77);
	});

	it("treats SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});
});

describe("getOpenAIStreamIdleTimeoutMs()", () => {
	it("honors the documented SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS first", () => {
		Bun.env.SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS = "88";
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(88);
	});

	it("falls back to the legacy PI_OPENAI_STREAM_IDLE_TIMEOUT_MS alias", () => {
		Bun.env.PI_OPENAI_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getOpenAIStreamIdleTimeoutMs()).toBe(42);
	});
});

describe("getStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)", () => {
	it("returns the per-provider fallback when env unset and idle timeout is undefined", () => {
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(300_000);
	});

	it("floors the first-event timeout at the per-provider fallback even when idle is shorter", () => {
		expect(getStreamFirstEventTimeoutMs(50_000, 300_000)).toBe(300_000);
	});

	it("never undershoots the steady-state idle timeout", () => {
		expect(getStreamFirstEventTimeoutMs(500_000, 300_000)).toBe(500_000);
	});

	it("lets PI_STREAM_FIRST_EVENT_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("treats PI_STREAM_FIRST_EVENT_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBeUndefined();
	});

	it("falls back to the 100s global default when no fallback or env is provided", () => {
		expect(getStreamFirstEventTimeoutMs()).toBe(100_000);
	});
});

describe("Codex semantic clock policy", () => {
	const cases: Array<{
		name: string;
		idle?: string[];
		first?: string;
		caller?: { streamIdleTimeoutMs?: number; streamFirstEventTimeoutMs?: number };
		expectedIdle?: number;
		expectedFirst: number;
	}> = [
		{ name: "absent", expectedIdle: 300_000, expectedFirst: 300_000 },
		{ name: "SKC alias wins", idle: ["60000", "70000", "80000"], expectedIdle: 60_000, expectedFirst: 300_000 },
		{ name: "PI_STREAM before PI_OPENAI", idle: ["70000", "80000"], expectedIdle: 70_000, expectedFirst: 300_000 },
		{ name: "long idle widens first", idle: ["450000"], expectedIdle: 450_000, expectedFirst: 450_000 },
		{ name: "short first env", first: "45000", expectedIdle: 300_000, expectedFirst: 45_000 },
		{
			name: "caller first wins",
			first: "60000",
			caller: { streamFirstEventTimeoutMs: 45_000 },
			expectedIdle: 300_000,
			expectedFirst: 45_000,
		},
		{
			name: "caller idle wins",
			idle: ["60000"],
			caller: { streamIdleTimeoutMs: 40_000 },
			expectedIdle: 40_000,
			expectedFirst: 300_000,
		},
		{
			name: "caller first NaN uses env",
			first: "45000",
			caller: { streamFirstEventTimeoutMs: NaN },
			expectedIdle: 300_000,
			expectedFirst: 45_000,
		},
		{
			name: "caller idle Infinity uses env",
			idle: ["60000"],
			caller: { streamIdleTimeoutMs: Infinity },
			expectedIdle: 60_000,
			expectedFirst: 300_000,
		},
		{
			name: "caller fractions truncate",
			caller: { streamIdleTimeoutMs: 1.9, streamFirstEventTimeoutMs: 0.5 },
			expectedIdle: 1,
			expectedFirst: 0,
		},
	];
	for (const value of ["bad", "NaN", "Infinity"]) {
		cases.push(
			{
				name: `invalid idle ${value} does not search aliases`,
				idle: [value, "70000", "80000"],
				expectedIdle: 300_000,
				expectedFirst: 300_000,
			},
			{ name: `invalid first ${value}`, first: value, expectedIdle: 300_000, expectedFirst: 300_000 },
			{
				name: `invalid first ${value} uses widened fallback`,
				idle: ["450000"],
				first: value,
				expectedIdle: 450_000,
				expectedFirst: 450_000,
			},
		);
	}
	for (const value of ["0", "-1", "", "   "]) {
		cases.push(
			{ name: `disabled idle '${value}' ignores aliases`, idle: [value, "70000", "80000"], expectedFirst: 300_000 },
			{ name: `disabled first '${value}'`, first: value, expectedIdle: 300_000, expectedFirst: 0 },
		);
	}
	for (const value of [0, -1]) {
		cases.push(
			{ name: `caller idle ${value}`, caller: { streamIdleTimeoutMs: value }, expectedFirst: 300_000 },
			{
				name: `caller first ${value}`,
				first: "45000",
				caller: { streamFirstEventTimeoutMs: value },
				expectedIdle: 300_000,
				expectedFirst: 0,
			},
		);
	}
	for (const fixture of cases) {
		it(fixture.name, () => {
			if (fixture.idle) {
				const keys =
					fixture.idle.length === 2
						? ["PI_STREAM_IDLE_TIMEOUT_MS", "PI_OPENAI_STREAM_IDLE_TIMEOUT_MS"]
						: [
								"SKC_OPENAI_STREAM_IDLE_TIMEOUT_MS",
								"PI_STREAM_IDLE_TIMEOUT_MS",
								"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
							];
				fixture.idle.forEach((value, index) => {
					Bun.env[keys[index]] = value;
				});
			}
			if (fixture.first !== undefined) Bun.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = fixture.first;
			const policy = resolveCodexStreamTimeoutPolicy(fixture.caller);
			expect(policy.idleTimeoutMs).toBe(fixture.expectedIdle);
			expect(policy.firstItemTimeoutMs).toBe(fixture.expectedFirst);
		});
	}

	it("carries the lazy boundary deadline once without rewriting raw caller values", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		try {
			const options = { streamIdleTimeoutMs: NaN, streamFirstEventTimeoutMs: 0 };
			const policy = resolveCodexStreamTimeoutPolicy(options);
			carryCodexStreamTimeoutPolicy(options, policy);
			clock.mockReturnValue(151_000);
			expect(takeCodexStreamTimeoutPolicy(options)).toEqual(policy);
			expect(options.streamIdleTimeoutMs).toBeNaN();
			expect(options.streamFirstEventTimeoutMs).toBe(0);
			expect(takeCodexStreamTimeoutPolicy(options).firstItemStartedAt).toBe(151_000);
		} finally {
			clock.mockRestore();
		}
	});

	it("rejects buffered admission at the exact inherited deadline", async () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(300_000);
		try {
			const source = async function* () {
				yield "buffered";
			};
			const guarded = iterateWithIdleTimeout(source(), {
				firstItemStartedAt: 0,
				firstItemTimeoutMs: 300_000,
				strictDeadline: true,
				errorMessage: "idle",
				firstItemErrorMessage: "first",
			});
			await expect(guarded.next()).rejects.toThrow("first");
		} finally {
			clock.mockRestore();
		}
	});
});
