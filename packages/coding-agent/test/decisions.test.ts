import { expect, test } from "bun:test";
import { createDecisionService } from "../src/decisions";
import type { DecisionBackend, DecisionRequest, DecisionResult } from "../src/decisions/types";
import { MAX_OPTIONS, validateQuestions } from "../src/decisions/types";

function backend(name: string, impl: DecisionBackend["decide"]): DecisionBackend {
	return { name, decide: impl };
}

const answered: DecisionResult = {
	answers: { route: { type: "choice", choice: "ralplan" } },
	backend: "stub",
	model: "stub/model",
	calibrated: false,
	durationMs: 1,
};

const request: DecisionRequest = {
	state: "실행 전에 합의된 계획부터 세워줘",
	questions: { route: { type: "choice", instructions: "어디로", criteria: { ralplan: "계획", none: "그냥" } } },
};

test("disabled service never calls a backend", async () => {
	let calls = 0;
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		backends: [
			backend("stub", async () => {
				calls += 1;
				return answered;
			}),
		],
	});
	expect(service.enabled).toBe(false);
	expect(await service.decide(request)).toBeNull();
	expect(calls).toBe(0);
});

test("a throwing backend fails open to the next one instead of rejecting", async () => {
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [
			backend("boom", async () => {
				throw new Error("network down");
			}),
			backend("stub", async () => answered),
		],
	});
	const result = await service.decide(request);
	expect(result?.answers.route).toEqual({ type: "choice", choice: "ralplan" });
});

test("resolves null rather than throwing when every backend is unavailable", async () => {
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [
			backend("absent", async () => null),
			backend("boom", async () => {
				throw new Error("offline");
			}),
		],
	});
	expect(await service.decide(request)).toBeNull();
});

test("a hung backend is abandoned at the timeout and reports null", async () => {
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		timeoutMs: 30,
		backends: [
			backend(
				"hang",
				req =>
					new Promise(resolve => {
						req.signal?.addEventListener("abort", () => resolve(null), { once: true });
					}),
			),
		],
	});
	const started = Date.now();
	expect(await service.decide(request)).toBeNull();
	expect(Date.now() - started).toBeLessThan(2000);
});

test("caller abort propagates into the backend", async () => {
	const controller = new AbortController();
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [
			backend(
				"watch",
				req =>
					new Promise(resolve => {
						req.signal?.addEventListener("abort", () => resolve(null), { once: true });
					}),
			),
		],
	});
	const pending = service.decide({ ...request, signal: controller.signal });
	controller.abort();
	expect(await pending).toBeNull();
});

test("rejects question sets an enum-constrained backend could not express", () => {
	expect(() => validateQuestions({})).toThrow(/must not be empty/);
	expect(() => validateQuestions({ q: { type: "choice", instructions: "x", criteria: { only: "one" } } })).toThrow(
		/2-16 options/,
	);
	expect(() => validateQuestions({ q: { type: "score", instructions: "x", criteria: ["a"] } })).toThrow(
		/2-16 options/,
	);
	const tooMany = Object.fromEntries(Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => [`o${i}`, "x"]));
	expect(() => validateQuestions({ q: { type: "choice", instructions: "x", criteria: tooMany } })).toThrow(
		/2-16 options/,
	);
	expect(() => validateQuestions({ q: { type: "noul", instructions: "  " } })).toThrow(/needs instructions/);
});

test("accepts the boundary sizes an enum can carry", () => {
	const exactly = Object.fromEntries(Array.from({ length: MAX_OPTIONS }, (_, i) => [`o${i}`, "x"]));
	expect(() => validateQuestions({ q: { type: "choice", instructions: "x", criteria: exactly } })).not.toThrow();
	expect(() =>
		validateQuestions({ q: { type: "score", instructions: "x", criteria: ["low", "high"] } }),
	).not.toThrow();
});

test("a backend that ignores its abort signal cannot hang the turn", async () => {
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		timeoutMs: 40,
		// Deliberately uncooperative: never resolves, never watches the signal.
		backends: [backend("stuck", () => new Promise<never>(() => {}))],
	});
	const started = Date.now();
	expect(await service.decide(request)).toBeNull();
	expect(Date.now() - started).toBeLessThan(2000);
});

// --- TypeSafe backend -------------------------------------------------------

import type { Question } from "../src/decisions/types";
import { createTypeSafeDecisionBackend } from "../src/decisions/typesafe-backend";

function registryWithKey(key: string | undefined) {
	return {
		async getApiKeyForProvider() {
			return key;
		},
	} as never;
}

const tsQuestions: Record<string, Question> = {
	dept: { type: "choice", instructions: "which team", criteria: { billing: "money", technical: "bugs" } },
	urgent: { type: "noul", instructions: "is it urgent" },
	sev: { type: "score", instructions: "severity", criteria: ["low", "mid", "high"] },
};

function jsonResponse(body: unknown, status = 200) {
	return async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("no stored key means the backend steps aside silently", async () => {
	let called = false;
	const backend = createTypeSafeDecisionBackend({
		registry: registryWithKey(undefined),
		fetchImpl: (async () => {
			called = true;
			return new Response("{}");
		}) as never,
	});
	expect(await backend.decide({ state: "x", questions: tsQuestions })).toBeNull();
	expect(called).toBe(false);
});

test("maps every answer type and is the only backend allowed to claim calibration", async () => {
	const backend = createTypeSafeDecisionBackend({
		registry: registryWithKey("sk-test"),
		fetchImpl: jsonResponse({
			model: "jev-1.13.0",
			answers: {
				dept: {
					type: "choice",
					choice: "technical",
					probabilities: { billing: 0.1, technical: 0.9 },
					confidence: 0.8,
				},
				urgent: { type: "noul", noul: 0.93 },
				sev: { type: "score", score: 1.7, legend: { "0": "low", "1": "mid", "2": "high" } },
			},
		}) as never,
	});
	const result = await backend.decide({ state: "payouts failing", questions: tsQuestions });
	expect(result?.calibrated).toBe(true);
	expect(result?.model).toBe("jev-1.13.0");
	expect(result?.answers.dept).toMatchObject({ type: "choice", choice: "technical" });
	expect(result?.answers.urgent).toMatchObject({ type: "noul", noul: 0.93 });
	// score keeps the fractional value and derives the discrete level from it
	expect(result?.answers.sev).toMatchObject({ type: "score", score: 1.7, level: 2 });
});

test("an option outside the declared set is dropped, not coerced", async () => {
	const backend = createTypeSafeDecisionBackend({
		registry: registryWithKey("sk-test"),
		fetchImpl: jsonResponse({ answers: { dept: { type: "choice", choice: "legal" } } }) as never,
	});
	const only = { dept: tsQuestions.dept as Question };
	expect(await backend.decide({ state: "x", questions: only })).toBeNull();
});

test("an HTTP failure resolves null so the next backend can answer", async () => {
	const backend = createTypeSafeDecisionBackend({
		registry: registryWithKey("sk-test"),
		fetchImpl: jsonResponse({ error: "rate limited" }, 429) as never,
	});
	expect(await backend.decide({ state: "x", questions: tsQuestions })).toBeNull();
});

test("sends the System One wire shape the hosted API documents", async () => {
	let sent: Record<string, unknown> | undefined;
	let url: string | undefined;
	let auth: string | null | undefined;
	const backend = createTypeSafeDecisionBackend({
		registry: registryWithKey("sk-test"),
		fetchImpl: (async (input: string, init: RequestInit) => {
			url = input;
			auth = new Headers(init.headers).get("Authorization");
			sent = JSON.parse(String(init.body));
			return new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 1 } } }));
		}) as never,
	});
	await backend.decide({ state: "s", questions: { urgent: tsQuestions.urgent as Question } });
	expect(url).toBe("https://api.typesafe.ai/v1/systemone");
	expect(auth).toBe("Bearer sk-test");
	expect(sent).toMatchObject({ state: "s", model: "jev-latest" });
	// noul carries no criteria on the wire
	expect(sent?.questions).toEqual({ urgent: { type: "noul", instructions: "is it urgent" } });
});

// --- cost guard --------------------------------------------------------------

import { createLlmDecisionBackend } from "../src/decisions/llm-backend";

/** Minimal Settings stub: role resolution reads usage order and the role mapping. */
function settingsStub(role = "test-model") {
	return {
		getStorage: () => undefined,
		getModelRole: () => role,
	} as never;
}

function registryWithModel(inputCostPerMTok: number, onGetApiKey?: () => void) {
	const model = {
		provider: "anthropic",
		id: "test-model",
		cost: { input: inputCostPerMTok, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
	};
	const registry = {
		getAvailable: () => [model],
		async getApiKey() {
			onGetApiKey?.();
			// Stop before the network: these tests only assert whether the guard was passed.
			return undefined;
		},
	};
	return { model, registry: registry as never };
}

test("declines a frontier model: a decision must never cost more than what it replaces", async () => {
	let reached = false;
	const { registry } = registryWithModel(15, () => {
		reached = true;
	});
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub() });
	expect(await backend.decide({ state: "라우팅 대상", questions: tsQuestions })).toBeNull();
	// Declined before touching credentials, so no request is ever prepared.
	expect(reached).toBe(false);
});

test("an explicit model override is the caller's call and bypasses the ceiling", async () => {
	let reached = false;
	const { registry, model } = registryWithModel(15, () => {
		reached = true;
	});
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub(), model: model as never });
	await backend.decide({ state: "x", questions: tsQuestions });
	expect(reached).toBe(true);
});

test("the ceiling is configurable for callers that accept the cost", async () => {
	let reached = false;
	const { registry } = registryWithModel(15, () => {
		reached = true;
	});
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub(), maxInputCostPerMTok: 100 });
	await backend.decide({ state: "x", questions: tsQuestions });
	expect(reached).toBe(true);
});

// --- local runtime preference ------------------------------------------------

import { clearLocalRuntimeLivenessCache } from "../src/decisions/llm-backend";

function registryWithLocal(localAlive: boolean) {
	const local = {
		provider: "lm-studio",
		id: "qwen3-4b-local",
		baseUrl: "http://127.0.0.1:1234/v1",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
	};
	const hosted = {
		provider: "anthropic",
		id: "claude-haiku-4-5",
		baseUrl: "https://api.anthropic.com",
		cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
	};
	let picked: string | undefined;
	const registry = {
		getAvailable: () => [hosted, local],
		async getApiKey(model: { provider: string; id: string }) {
			picked = `${model.provider}/${model.id}`;
			return undefined; // stop before the network
		},
	};
	const fetchImpl = (async (url: string) => {
		if (!url.startsWith("http://127.0.0.1:1234")) throw new Error(`unexpected probe: ${url}`);
		if (!localAlive) throw new Error("ECONNREFUSED");
		return new Response("{}", { status: 200 });
	}) as never;
	return { registry: registry as never, fetchImpl, picked: () => picked };
}

test("a live local runtime wins: zero tokens and nothing leaves the machine", async () => {
	clearLocalRuntimeLivenessCache();
	const { registry, fetchImpl, picked } = registryWithLocal(true);
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub(), fetchImpl });
	await backend.decide({ state: "라우팅 대상 문장", questions: tsQuestions });
	expect(picked()).toBe("lm-studio/qwen3-4b-local");
});

test("a dead local runtime is skipped rather than hung on", async () => {
	clearLocalRuntimeLivenessCache();
	const { registry, fetchImpl, picked } = registryWithLocal(false);
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub(), fetchImpl });
	await backend.decide({ state: "라우팅 대상 문장", questions: tsQuestions });
	// The registry lists local models whether or not the runtime is up, so the probe is
	// the only thing standing between a decision and a dead endpoint.
	expect(picked()).toBe("anthropic/claude-haiku-4-5");
});

test("liveness is probed once, not on every decision", async () => {
	clearLocalRuntimeLivenessCache();
	let probes = 0;
	const { registry } = registryWithLocal(true);
	const counting = (async (url: string) => {
		probes += 1;
		if (!url.startsWith("http://127.0.0.1:1234")) throw new Error("unexpected");
		return new Response("{}", { status: 200 });
	}) as never;
	const backend = createLlmDecisionBackend({ registry, settings: settingsStub(), fetchImpl: counting });
	await backend.decide({ state: "첫 번째 판단", questions: tsQuestions });
	await backend.decide({ state: "두 번째 판단", questions: tsQuestions });
	expect(probes).toBe(1);
});
