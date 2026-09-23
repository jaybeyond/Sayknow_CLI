/**
 * End-to-end cover for the routing subsystem: settings in, dispatch chain out.
 *
 * The unit suite (`task-model-routing.test.ts`) pins each rule in isolation
 * against a hand-built policy. This one starts from a real `Settings` object and
 * walks the whole path a spawn takes — settings gate, policy construction,
 * one classifier call per child, provenance-tagged chain, attribution — because
 * every one of those steps has been wrong at least once while the rules it
 * composes were individually right.
 *
 * What it deliberately does NOT cover: the `TaskTool` plumbing that calls this
 * once per child and hands the chain to `runSubprocess`. That path needs a live
 * subagent spawn; it is covered by types and by the dispatch call sites, not here.
 */
import { describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { createDecisionService } from "../src/decisions";
import {
	buildTaskRoutingPolicyFromSettings,
	resolveDeclaredSpecialtyRouting,
	routeTaskModel,
	type TaskRoutingResult,
} from "../src/decisions/task-routing";
import type { DecisionBackend, DecisionResult } from "../src/decisions/types";

const FAST = "anthropic/claude-haiku-4-5";
const BALANCED = "anthropic/claude-sonnet-5";
const DEEP = "anthropic/claude-opus-5";
const BACKEND_MODEL = "anthropic/claude-opus-5-5:high";
const FRONTEND_MODEL = "xai/grok-4.7:high";
const TESTING_MODEL = "anthropic/claude-haiku-4-5:low";
const BASELINE = "anthropic/claude-sonnet-4-6:high";

/** Long enough to clear the router's minimum-assignment guard. */
const IMPLEMENTATION_WORK = "Add the retry budget to src/net/client.ts and update the two call sites that read it.";
const TESTING_WORK = "Write regression tests for the retry budget covering exhaustion, reset and the zero-budget case.";
const BACKEND_WORK = "Design the sharding strategy for the event store and write up the failover ordering guarantees.";
const FRONTEND_WORK =
	"Lay out the billing settings screen: spacing scale, empty state, and the destructive-action modal.";

/**
 * A backend that answers from a lookup keyed by assignment.
 *
 * Per-child routing only means something if two children in one batch can get
 * different answers, so the stub has to vary by assignment rather than return a
 * fixed verdict the way the unit suite's does.
 */
function routerFor(
	answersByAssignment: Record<string, DecisionResult["answers"]>,
	calibrated: boolean,
): ReturnType<typeof createDecisionService> {
	const backend: DecisionBackend = {
		name: "stub",
		async decide(request): Promise<DecisionResult> {
			// The router folds the agent name and assignment into one `state` string,
			// so match on substring rather than reaching for a structured field.
			const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
			const match = Object.keys(answersByAssignment).find(assignment => state.includes(assignment));
			if (!match) throw new Error(`Stub backend has no answer for state: ${state}`);
			const answers = answersByAssignment[match];
			if (!answers) throw new Error(`Stub backend matched ${match} but holds no answers`);
			return { answers, backend: "stub", model: "stub/model", calibrated, durationMs: 1 };
		},
	};
	return createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [backend],
	});
}

/**
 * A full answer set. The specialty always carries a probability so the
 * uncalibrated cases prove something real: the value is present in the answer
 * and must still never reach the result when the backend is not calibrated.
 */
function specialtyAnswers(
	specialty: string,
	clarity: number,
	tier = "balanced",
	confidence = 0.9,
): DecisionResult["answers"] {
	return {
		tier: { type: "choice", choice: tier, confidence },
		risky: { type: "noul", noul: 0.1 },
		specialty: { type: "choice", choice: specialty, confidence },
		specialtyClear: { type: "noul", noul: clarity },
	};
}

function selectors(routed: TaskRoutingResult | null): string[] {
	if (!routed) throw new Error("Expected the router to produce a decision");
	return routed.candidates.map(candidate => candidate.selector);
}

function sources(routed: TaskRoutingResult | null): string[] {
	if (!routed) throw new Error("Expected the router to produce a decision");
	return routed.candidates.map(candidate => candidate.source);
}

function configuredSettings(overrides: Record<string, unknown> = {}) {
	return Settings.isolated({
		"task.modelRouting.enabled": true,
		"task.modelRouting.fastModel": FAST,
		"task.modelRouting.balancedModel": BALANCED,
		"task.modelRouting.deepModel": DEEP,
		"task.modelRouting.specialtyModels": {
			backendArchitecture: BACKEND_MODEL,
			frontendDesign: FRONTEND_MODEL,
			testing: TESTING_MODEL,
		},
		...overrides,
	} as never);
}

describe("settings gate", () => {
	test("routing stays off when the feature flag is off, however much is configured", () => {
		const settings = configuredSettings({ "task.modelRouting.enabled": false });
		expect(buildTaskRoutingPolicyFromSettings(settings)).toBeNull();
	});

	test("a single tier is not an axis and does not enable routing", () => {
		const settings = Settings.isolated({
			"task.modelRouting.enabled": true,
			"task.modelRouting.deepModel": DEEP,
		} as never);
		expect(buildTaskRoutingPolicyFromSettings(settings)).toBeNull();
	});

	test("one configured specialty is enough on its own", () => {
		const settings = Settings.isolated({
			"task.modelRouting.enabled": true,
			"task.modelRouting.specialtyModels": { review: DEEP },
		} as never);
		const policy = buildTaskRoutingPolicyFromSettings(settings);
		expect(policy).not.toBeNull();
		expect(policy?.specialtyModels?.review).toBe(DEEP);
	});

	test("a blank specialty value does not count as configured", () => {
		const settings = Settings.isolated({
			"task.modelRouting.enabled": true,
			"task.modelRouting.specialtyModels": { review: "   " },
		} as never);
		expect(buildTaskRoutingPolicyFromSettings(settings)).toBeNull();
	});

	test("the legacy frontend model still enables routing by itself", () => {
		const settings = Settings.isolated({
			"task.modelRouting.enabled": true,
			"task.modelRouting.frontendModel": FRONTEND_MODEL,
		} as never);
		expect(buildTaskRoutingPolicyFromSettings(settings)).not.toBeNull();
	});
});

describe("per-child dispatch", () => {
	test("two children of one executor batch route independently", async () => {
		// The whole point of moving routing per-child: an implementation slice and
		// a test slice arrive in the same call, on the same agent, and must not be
		// forced to share one classification.
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor(
			{
				[IMPLEMENTATION_WORK]: specialtyAnswers("implementation", 0.9),
				[TESTING_WORK]: specialtyAnswers("testing", 0.9),
			},
			true,
		);

		const implementation = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: IMPLEMENTATION_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		const testing = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		// `implementation` has no configured model, so it falls to the tier axis;
		// `testing` does, so it takes the specialty. Same agent, different chains.
		expect(selectors(testing)[0]).toBe(TESTING_MODEL);
		expect(sources(testing)[0]).toBe("specialty");
		expect(selectors(implementation)[0]).not.toBe(TESTING_MODEL);
	});

	test("every composed chain ends at the role baseline", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [TESTING_WORK]: specialtyAnswers("testing", 0.9) }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		// A specialty that cannot authenticate must still land somewhere the role
		// can actually run, so the baseline is the tail of the chain, never dropped.
		expect(selectors(routed).at(-1)).toBe(BASELINE);
		expect(sources(routed).at(-1)).toBe("baseline");
	});

	test("a multi-entry baseline chain survives intact behind the specialty", async () => {
		const fallback = "anthropic/claude-sonnet-4-5:high";
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [TESTING_WORK]: specialtyAnswers("testing", 0.9) }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE, fallback],
		});

		expect(selectors(routed).slice(-2)).toEqual([BASELINE, fallback]);
	});
});

describe("role eligibility", () => {
	test("a planner takes backendArchitecture", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [BACKEND_WORK]: specialtyAnswers("backendArchitecture", 0.9) }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "planner",
			assignment: BACKEND_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)[0]).toBe(BACKEND_MODEL);
		expect(routed?.requestedSpecialty).toBe("backendArchitecture");
	});

	test("an architect takes frontendDesign", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [FRONTEND_WORK]: specialtyAnswers("frontendDesign", 0.9) }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "architect",
			assignment: FRONTEND_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)[0]).toBe(FRONTEND_MODEL);
	});

	test("an executor cannot be given a planning specialty", async () => {
		// The classifier is free to answer anything; eligibility is enforced here,
		// not in the prompt, so a bad answer degrades instead of mis-routing.
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [BACKEND_WORK]: specialtyAnswers("backendArchitecture", 0.95) }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: BACKEND_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)).not.toContain(BACKEND_MODEL);
		expect(routed?.requestedSpecialty).toBeUndefined();
	});
});

describe("attribution honesty", () => {
	test("a calibrated backend reports a real probability and no ordinal", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const answers = specialtyAnswers("testing", 0.9, "balanced", 0.88);
		const service = routerFor({ [TESTING_WORK]: answers }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(routed?.calibrated).toBe(true);
		expect(routed?.confidence).toBe(0.88);
		expect(routed?.ordinalStrength).toBeUndefined();
	});

	test("an uncalibrated backend reports an ordinal and never invents a probability", async () => {
		// This is the line that must not move: an ordinary LLM returns no
		// probabilities at all, so reporting one would be fabricated evidence.
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [TESTING_WORK]: specialtyAnswers("testing", 0.9) }, false);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(routed?.calibrated).toBe(false);
		expect(routed?.confidence).toBeUndefined();
		expect(routed?.ordinalStrength).toBe(0.9);
	});

	test("an unclear uncalibrated answer declines the specialty", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [TESTING_WORK]: specialtyAnswers("testing", 0.5) }, false);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)).not.toContain(TESTING_MODEL);
	});

	test("a risky assignment composes tier and baseline only, skipping the specialty", async () => {
		// Risk outranks specialty: the point of the floor is capability, and a
		// lateral swap can move sideways into something weaker.
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const answers = specialtyAnswers("testing", 0.95, "deep");
		answers.risky = { type: "noul", noul: 0.95 };
		const service = routerFor({ [TESTING_WORK]: answers }, true);

		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)).not.toContain(TESTING_MODEL);
		expect(sources(routed)).not.toContain("specialty");
		expect(sources(routed).at(-1)).toBe("baseline");
	});
});

describe("declared specialty", () => {
	// The deterministic half. The user's instruction was literal: "if I set it,
	// use it; only use something else when that model errors". Everything here
	// pins that no gate the classifier path has can stand between a configured
	// specialty model and a spawn that declares the work.

	test("runs on the configured model with every routing switch off", () => {
		const settings = Settings.isolated({
			"task.modelRouting.enabled": false,
			"decisions.enabled": false,
			"task.modelRouting.specialtyModels": { frontendDesign: FRONTEND_MODEL },
		} as never);

		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "planner",
			specialty: "frontendDesign",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});

		expect(selectors(routed)).toEqual([FRONTEND_MODEL, BASELINE]);
		expect(sources(routed)).toEqual(["specialty", "baseline"]);
		expect(routed?.declared).toBe(true);
		expect(routed?.requestedSpecialty).toBe("frontendDesign");
	});

	test("does not fabricate classifier evidence", () => {
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { review: DEEP },
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "critic",
			specialty: "review",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(routed?.calibrated).toBe(false);
		expect(routed?.confidence).toBeUndefined();
		expect(routed?.ordinalStrength).toBeUndefined();
		expect(routed?.tier).toBeNull();
		expect(routed?.reason).toContain("declared");
	});

	test("the role baseline is always the tail so a dead specialty model cannot strand the spawn", () => {
		// Error-driven fallback lives in the child session's fallback chain; what
		// this layer owes it is a chain whose tail is the model the role would have
		// run on anyway. Without that, a 429 on the specialty model is terminal.
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { implementation: BACKEND_MODEL },
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "executor",
			specialty: "implementation",
			currentModel: BASELINE,
			baselineChain: [BASELINE, DEEP],
		});
		expect(selectors(routed)).toEqual([BACKEND_MODEL, BASELINE, DEEP]);
		expect(sources(routed).at(-1)).toBe("baseline");
	});

	test("ignores the menu's role grouping: a frontend build delegated to executor still gets the frontend model", () => {
		// The setting is one flat map. Refusing here would make "frontend uses a
		// different model" false for exactly the spawns the user cares about.
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { frontendDesign: FRONTEND_MODEL },
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "executor",
			specialty: "frontendDesign",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(routed?.model).toBe(FRONTEND_MODEL);
	});

	test("declines when nothing is configured for the specialty", () => {
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { testing: TESTING_MODEL },
		} as never);
		expect(
			resolveDeclaredSpecialtyRouting(settings, {
				agentName: "planner",
				specialty: "backendArchitecture",
				currentModel: BASELINE,
				baselineChain: [BASELINE],
			}),
		).toBeNull();
	});

	test("a blank entry is not configured", () => {
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { testing: "   " },
		} as never);
		expect(
			resolveDeclaredSpecialtyRouting(settings, {
				agentName: "executor",
				specialty: "testing",
				currentModel: BASELINE,
				baselineChain: [BASELINE],
			}),
		).toBeNull();
	});

	test("declines when the configured model is already the role's own", () => {
		// Reporting a route here would claim a swap that never happened; the
		// receipt must not say "specialty" for a spawn that ran on the baseline.
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { implementation: BASELINE },
		} as never);
		expect(
			resolveDeclaredSpecialtyRouting(settings, {
				agentName: "executor",
				specialty: "implementation",
				currentModel: BASELINE,
				baselineChain: [BASELINE],
			}),
		).toBeNull();
	});

	test("matches on the model head, so a thinking-suffix difference is not a swap", () => {
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { implementation: "anthropic/claude-sonnet-4-6:low" },
		} as never);
		expect(
			resolveDeclaredSpecialtyRouting(settings, {
				agentName: "executor",
				specialty: "implementation",
				currentModel: BASELINE,
				baselineChain: [BASELINE],
			}),
		).toBeNull();
	});

	test("the legacy frontend selector still answers for frontendDesign when no entry replaced it", () => {
		const settings = Settings.isolated({
			"task.modelRouting.frontendModel": FRONTEND_MODEL,
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "architect",
			specialty: "frontendDesign",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(routed?.model).toBe(FRONTEND_MODEL);
		expect(routed?.requestedSource).toBe("legacy-frontend");
		expect(routed?.declared).toBe(true);
	});

	test("an explicit entry beats the legacy selector", () => {
		const settings = Settings.isolated({
			"task.modelRouting.frontendModel": DEEP,
			"task.modelRouting.specialtyModels": { frontendDesign: FRONTEND_MODEL },
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "architect",
			specialty: "frontendDesign",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(routed?.model).toBe(FRONTEND_MODEL);
		expect(routed?.requestedSource).toBe("specialty");
	});

	test("a chain-valued specialty keeps its order ahead of the baseline", () => {
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { review: [DEEP, BALANCED] },
		} as never);
		const routed = resolveDeclaredSpecialtyRouting(settings, {
			agentName: "critic",
			specialty: "review",
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(selectors(routed)).toEqual([DEEP, BALANCED, BASELINE]);
	});

	test("classifier results are marked undeclared so receipts can tell the two apart", async () => {
		const policy = buildTaskRoutingPolicyFromSettings(configuredSettings());
		if (!policy) throw new Error("Expected settings to enable routing");
		const service = routerFor({ [TESTING_WORK]: specialtyAnswers("testing", 0.9) }, true);
		const routed = await routeTaskModel(service, policy, {
			agentName: "executor",
			assignment: TESTING_WORK,
			currentModel: BASELINE,
			baselineChain: [BASELINE],
		});
		expect(routed?.declared).toBe(false);
	});
});
