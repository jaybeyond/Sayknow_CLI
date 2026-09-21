import { expect, test } from "bun:test";
import { createDecisionService } from "../src/decisions";
import { DEFAULT_TASK_ROUTING_POLICY, routeTaskModel, type TaskRoutingPolicy } from "../src/decisions/task-routing";
import type { DecisionBackend, DecisionResult } from "../src/decisions/types";

const TIERS = {
	fast: "anthropic/claude-haiku-4-5",
	balanced: "anthropic/claude-sonnet-5",
	deep: "anthropic/claude-opus-5",
};
const POLICY: TaskRoutingPolicy = { ...DEFAULT_TASK_ROUTING_POLICY, tiers: TIERS };
const ASSIGNMENT = "Rename the helper in src/utils/date.ts and update its two callers.";

function service(answers: DecisionResult["answers"], calibrated = true, confidence?: number) {
	const backend: DecisionBackend = {
		name: "stub",
		async decide(): Promise<DecisionResult> {
			return { answers, backend: "stub", model: "stub/model", calibrated, durationMs: 1 };
		},
	};
	void confidence;
	return createDecisionService({ registry: {} as never, settings: {} as never, enabled: true, backends: [backend] });
}

function tierAnswer(choice: string, confidence?: number): DecisionResult["answers"] {
	return { tier: { type: "choice", choice, ...(confidence === undefined ? {} : { confidence }) } };
}

test("a confident downgrade below the higher bar is refused", async () => {
	// Moving to a cheaper model is the move that costs a retry when it is wrong,
	// so it clears a higher bar than moving up. 0.6 passes the upgrade bar but not this.
	const routed = await routeTaskModel(service(tierAnswer("fast", 0.6)), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.deep,
	});
	expect(routed).toBeNull();
});

test("the same downgrade above the higher bar is taken", async () => {
	const routed = await routeTaskModel(service(tierAnswer("fast", 0.8)), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.deep,
	});
	expect(routed).toMatchObject({ model: TIERS.fast, tier: "fast" });
});

test("an upgrade clears the lower bar at a confidence a downgrade could not", async () => {
	const routed = await routeTaskModel(service(tierAnswer("deep", 0.6)), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.fast,
	});
	expect(routed).toMatchObject({ model: TIERS.deep, tier: "deep" });
});

test("an uncalibrated backend may move up but never down", async () => {
	// A forced enum answer carries no real confidence. Spending less on that is
	// the bad trade; spending more only risks an overpriced answer.
	const up = await routeTaskModel(service(tierAnswer("deep"), false), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.fast,
	});
	expect(up).toMatchObject({ tier: "deep" });

	const down = await routeTaskModel(service(tierAnswer("fast"), false), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.deep,
	});
	expect(down).toBeNull();
});

test("irreversible work takes the deepest tier past both bars", async () => {
	const answers: DecisionResult["answers"] = {
		...tierAnswer("fast", 0.02),
		risky: { type: "noul", noul: 0.94 },
	};
	const routed = await routeTaskModel(service(answers), POLICY, {
		agentName: "executor",
		assignment: "Rotate the production database credentials and redeploy.",
		currentModel: TIERS.fast,
	});
	expect(routed).toMatchObject({ tier: "deep", reason: "deep, forced by risk" });
});

test("risk raises the floor and never lowers one", async () => {
	// Without the clamp, "this is risky" would pull an assignment already running
	// deep down to whatever cheap tier the classifier named — the opposite of the rule.
	const answers: DecisionResult["answers"] = {
		...tierAnswer("fast", 0.9),
		risky: { type: "noul", noul: 0.95 },
	};
	const routed = await routeTaskModel(service(answers), POLICY, {
		agentName: "executor",
		assignment: "Delete the stale release tags from the public registry.",
		currentModel: TIERS.deep,
	});
	// Already deepest and risk cannot lower it, so there is nothing to change.
	expect(routed).toBeNull();
});

test("a single configured tier is not a ladder and never fires", async () => {
	const routed = await routeTaskModel(
		service(tierAnswer("deep", 1)),
		{ ...POLICY, tiers: { deep: TIERS.deep } },
		{
			agentName: "executor",
			assignment: ASSIGNMENT,
			currentModel: TIERS.fast,
		},
	);
	expect(routed).toBeNull();
});

test("a thinking suffix does not make a model look like a different tier", async () => {
	// Configured roles carry `:high` style suffixes that the tier table may omit.
	// Comparing them raw would read "already deep" as "not a tier at all".
	const routed = await routeTaskModel(service(tierAnswer("deep", 1)), POLICY, {
		agentName: "architect",
		assignment: ASSIGNMENT,
		currentModel: `${TIERS.deep}:high`,
	});
	expect(routed).toBeNull();
});

test("an answer outside the tier enum leaves the configured model alone", async () => {
	const routed = await routeTaskModel(service(tierAnswer("gigantic", 1)), POLICY, {
		agentName: "executor",
		assignment: ASSIGNMENT,
		currentModel: TIERS.fast,
	});
	expect(routed).toBeNull();
});

test("a trivially short assignment is not worth a model call", async () => {
	let called = false;
	const backend: DecisionBackend = {
		name: "stub",
		async decide(): Promise<DecisionResult> {
			called = true;
			return { answers: tierAnswer("deep", 1), backend: "stub", model: "m", calibrated: true, durationMs: 1 };
		},
	};
	const routed = await routeTaskModel(
		createDecisionService({ registry: {} as never, settings: {} as never, enabled: true, backends: [backend] }),
		POLICY,
		{ agentName: "executor", assignment: "fix typo", currentModel: TIERS.fast },
	);
	expect(routed).toBeNull();
	expect(called).toBe(false);
});

// --- domain axis (frontend planning) -----------------------------------------

const FRONTEND = "openai-codex/gpt-5.6-sol:high";
const POLICY_FE: TaskRoutingPolicy = { ...POLICY, frontendModel: FRONTEND };

function domainAnswer(noul: number): DecisionResult["answers"] {
	return { tier: { type: "choice", choice: "balanced", confidence: 0.9 }, domain: { type: "noul", noul } };
}

test("frontend planning on a planning role takes the domain model laterally", async () => {
	const routed = await routeTaskModel(service(domainAnswer(0.9)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: "openai-codex/gpt-5.6-terra:high",
	});
	expect(routed).toMatchObject({ model: FRONTEND, tier: null });
});

test("architect is a planning role too", async () => {
	const routed = await routeTaskModel(service(domainAnswer(0.85)), POLICY_FE, {
		agentName: "architect",
		assignment: "다크모드 색상 시스템 설계를 검토하고 컴포넌트 토큰 구조를 계획해줘",
		// Not the frontend model — otherwise "already there" correctly refuses.
		currentModel: "openai-codex/gpt-5.6-terra:high",
	});
	expect(routed).toMatchObject({ model: FRONTEND, tier: null });
});

test("the executor is never domain-swapped — implementation keeps the ladder", async () => {
	// The user's intent: the design model *plans* the frontend; another model
	// still writes it. A confident frontend read must not move an executor.
	const routed = await routeTaskModel(service(domainAnswer(1)), POLICY_FE, {
		agentName: "executor",
		assignment: "온보딩 화면 컴포넌트를 만들어줘",
		currentModel: TIERS.fast,
	});
	expect(routed).toBeNull();
});

test("below the single domain bar there is no swap either way", async () => {
	// Lateral swap has one bar: wrong either way costs quality symmetrically.
	for (const noul of [0.3, 0.55]) {
		const routed = await routeTaskModel(service(domainAnswer(noul)), POLICY_FE, {
			agentName: "planner",
			assignment: "일반적인 리팩토링 순서를 계획해줘",
			currentModel: "openai-codex/gpt-5.6-terra:high",
		});
		expect(routed).toBeNull();
	}
});

test("an unconfigured frontend model disables the domain axis entirely", async () => {
	const routed = await routeTaskModel(service(domainAnswer(1)), POLICY, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계해줘",
		currentModel: "openai-codex/gpt-5.6-terra:high",
	});
	expect(routed).toBeNull();
});

test("the domain swap does not need a tier ladder", async () => {
	// Domain and difficulty are separate axes; configuring only a frontend model
	// must still route planning roles on domain.
	const routed = await routeTaskModel(
		service(domainAnswer(0.9)),
		{ ...POLICY_FE, tiers: {} },
		{
			agentName: "planner",
			assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
			currentModel: "openai-codex/gpt-5.6-terra:high",
		},
	);
	expect(routed).toMatchObject({ model: FRONTEND });
});

test("a role already on the frontend model is left alone", async () => {
	const routed = await routeTaskModel(service(domainAnswer(0.9)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계해줘",
		currentModel: FRONTEND,
	});
	expect(routed).toBeNull();
});

test("backend planning falls through to the difficulty ladder untouched", async () => {
	const routed = await routeTaskModel(service(domainAnswer(0.1)), POLICY_FE, {
		agentName: "planner",
		assignment: "결제 연동 마이그레이션 순서를 짜줘. 롤백 불가 구간이 있다",
		currentModel: TIERS.fast,
	});
	// The stub answers balanced; the point is the ladder answered, not the domain swap.
	expect(routed).toMatchObject({ model: TIERS.balanced, tier: "balanced" });
});
