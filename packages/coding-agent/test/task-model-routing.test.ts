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

// --- specialty axis (kind of work) -------------------------------------------

const FRONTEND = "openai-codex/gpt-5.6-sol:high";
const POLICY_FE: TaskRoutingPolicy = { ...POLICY, frontendModel: FRONTEND };
const BASELINE = "openai-codex/gpt-5.6-terra:high";

/**
 * One classifier call answers both axes. The specialty choice carries the
 * calibrated confidence; `specialtyClear` carries the ordinal a backend that
 * cannot report probabilities uses instead.
 */
function specialtyAnswer(choice: string, clarity: number, confidence?: number): DecisionResult["answers"] {
	return {
		tier: { type: "choice", choice: "balanced", confidence: 0.9 },
		specialty: { type: "choice", choice, ...(confidence === undefined ? {} : { confidence }) },
		specialtyClear: { type: "noul", noul: clarity },
	};
}

test("frontend design on a planning role takes the specialty model laterally", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.9, 0.9)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed).toMatchObject({ model: FRONTEND, tier: null, requestedSpecialty: "frontendDesign" });
});

test("architect is a planning role too", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.9, 0.85)), POLICY_FE, {
		agentName: "architect",
		assignment: "다크모드 색상 시스템 설계를 검토하고 컴포넌트 토큰 구조를 계획해줘",
		// Not the frontend model — otherwise "already there" correctly refuses.
		currentModel: BASELINE,
	});
	expect(routed).toMatchObject({ model: FRONTEND, tier: null });
});

test("the executor never takes a design specialty — implementation keeps the ladder", async () => {
	// The user's intent: the design model *plans* the frontend; another model
	// still writes it. A confident frontend read must not move an executor.
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 1, 1)), POLICY_FE, {
		agentName: "executor",
		assignment: "온보딩 화면 컴포넌트를 기존 디자인 토큰에 맞춰 구현해줘",
		currentModel: TIERS.fast,
	});
	expect(routed).toMatchObject({ requestedSource: "tier" });
	expect(routed?.requestedSpecialty).toBeUndefined();
});

test("below the single calibrated bar there is no swap either way", async () => {
	// Lateral swap has one bar: wrong either way costs quality symmetrically.
	for (const confidence of [0.3, 0.55]) {
		const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 1, confidence)), POLICY_FE, {
			agentName: "planner",
			assignment: "일반적인 리팩토링 순서를 계획해줘",
			currentModel: BASELINE,
		});
		expect(routed?.requestedSpecialty).toBeUndefined();
	}
});

test("an unconfigured specialty disables that swap entirely", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 1, 1)), POLICY, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed?.requestedSpecialty).toBeUndefined();
});

test("the specialty swap does not need a tier ladder", async () => {
	// Specialty and difficulty are separate axes; configuring only a specialty
	// model must still route a compatible role.
	const routed = await routeTaskModel(
		service(specialtyAnswer("frontendDesign", 0.9, 0.9)),
		{ ...POLICY_FE, tiers: {} },
		{
			agentName: "planner",
			assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
			currentModel: BASELINE,
		},
	);
	expect(routed).toMatchObject({ model: FRONTEND });
});

test("a role already on the specialty model is left alone", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.9, 0.9)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: FRONTEND,
	});
	expect(routed).toBeNull();
});

test("a neutral classification falls through to the difficulty ladder untouched", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("none", 0.1)), POLICY_FE, {
		agentName: "planner",
		assignment: "결제 연동 마이그레이션 순서를 짜줘. 롤백 불가 구간이 있다",
		currentModel: TIERS.fast,
	});
	// The stub answers balanced; the point is the ladder answered, not a swap.
	expect(routed).toMatchObject({ model: TIERS.balanced, tier: "balanced", requestedSource: "tier" });
});

test("an explicit specialty entry wins over the legacy frontend selector", async () => {
	const explicit = "anthropic/claude-opus-5:high";
	const routed = await routeTaskModel(
		service(specialtyAnswer("frontendDesign", 0.9, 0.9)),
		{ ...POLICY_FE, specialtyModels: { frontendDesign: explicit } },
		{
			agentName: "planner",
			assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
			currentModel: BASELINE,
		},
	);
	expect(routed).toMatchObject({ model: explicit, requestedSource: "specialty" });
});

test("the legacy frontend selector is still reported as legacy, not as a new entry", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.9, 0.9)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed).toMatchObject({ requestedSource: "legacy-frontend" });
});

test("backend architecture routes planning roles to its own model", async () => {
	const backend = "anthropic/claude-opus-5:xhigh";
	const routed = await routeTaskModel(
		service(specialtyAnswer("backendArchitecture", 0.9, 0.9)),
		{ ...POLICY, specialtyModels: { backendArchitecture: backend } },
		{ agentName: "architect", assignment: "결제 서비스의 API 경계와 데이터 모델을 설계해줘", currentModel: BASELINE },
	);
	expect(routed).toMatchObject({ model: backend, requestedSpecialty: "backendArchitecture", tier: null });
});

test("implementation and testing route the executor, review routes the critic", async () => {
	const impl = "anthropic/claude-sonnet-5:low";
	const tests = "anthropic/claude-haiku-4-5";
	const review = "anthropic/claude-opus-5:xhigh";
	const policy: TaskRoutingPolicy = {
		...POLICY,
		specialtyModels: { implementation: impl, testing: tests, review },
	};

	const implementation = await routeTaskModel(service(specialtyAnswer("implementation", 0.9, 0.9)), policy, {
		agentName: "executor",
		assignment: "기존 패턴을 따라 사용자 조회 핸들러를 추가해줘",
		currentModel: BASELINE,
	});
	expect(implementation).toMatchObject({ model: impl, requestedSpecialty: "implementation" });

	const testing = await routeTaskModel(service(specialtyAnswer("testing", 0.9, 0.9)), policy, {
		agentName: "executor",
		assignment: "이 회귀에 대한 집중 테스트를 설계하고 작성해줘",
		currentModel: BASELINE,
	});
	expect(testing).toMatchObject({ model: tests, requestedSpecialty: "testing" });

	const reviewed = await routeTaskModel(service(specialtyAnswer("review", 0.9, 0.9)), policy, {
		agentName: "critic",
		assignment: "이 변경의 정확성과 회귀 위험, 유지보수성을 검토해줘",
		currentModel: BASELINE,
	});
	expect(reviewed).toMatchObject({ model: review, requestedSpecialty: "review" });

	// review belongs to the critic, so the same answer must not move an executor.
	const misrouted = await routeTaskModel(service(specialtyAnswer("review", 0.9, 0.9)), policy, {
		agentName: "executor",
		assignment: "이 변경의 정확성과 회귀 위험, 유지보수성을 검토해줘",
		currentModel: BASELINE,
	});
	expect(misrouted?.requestedSpecialty).toBeUndefined();
});

// --- uncalibrated backend ----------------------------------------------------

test("an uncalibrated backend routes on a high ordinal and never claims confidence", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.8), false), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});

	expect(routed).toMatchObject({ model: FRONTEND, calibrated: false, ordinalStrength: 0.8 });
	// The ordinal ranks; it is not a probability and must never be reported as one.
	expect(routed?.confidence).toBeUndefined();
	expect(routed?.reason).toContain("uncalibrated");
});

test("an uncalibrated backend declines just below the ordinal bar", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 0.74), false), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed?.requestedSpecialty).toBeUndefined();
});

test("a calibrated backend ignores the ordinal and uses its confidence", async () => {
	// High ordinal, low confidence: the calibrated bar is the one that governs.
	const routed = await routeTaskModel(service(specialtyAnswer("frontendDesign", 1, 0.2)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed?.requestedSpecialty).toBeUndefined();
});

test("an unrecognized specialty option is declined rather than coerced", async () => {
	const routed = await routeTaskModel(service(specialtyAnswer("frontenddesign", 1, 1)), POLICY_FE, {
		agentName: "planner",
		assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
		currentModel: BASELINE,
	});
	expect(routed?.requestedSpecialty).toBeUndefined();
});

// --- candidate composition ---------------------------------------------------

test("a specialty chain is composed ahead of the tier and the role baseline", async () => {
	const routed = await routeTaskModel(
		service(specialtyAnswer("frontendDesign", 0.9, 0.9)),
		{ ...POLICY, specialtyModels: { frontendDesign: ["design/primary", "design/secondary"] } },
		{
			agentName: "planner",
			assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
			currentModel: BASELINE,
			baselineChain: [BASELINE, "openai-codex/gpt-5.6-terra:low"],
		},
	);

	expect(routed?.candidates).toEqual([
		{ selector: "design/primary", source: "specialty", specialty: "frontendDesign" },
		{ selector: "design/secondary", source: "specialty", specialty: "frontendDesign" },
		{ selector: TIERS.balanced, source: "tier", tier: "balanced" },
		{ selector: BASELINE, source: "baseline" },
		{ selector: "openai-codex/gpt-5.6-terra:low", source: "baseline" },
	]);
});

test("irreversible work outranks the specialty axis and never admits it", async () => {
	const answers: DecisionResult["answers"] = {
		...specialtyAnswer("frontendDesign", 1, 1),
		risky: { type: "noul", noul: 0.94 },
	};
	const routed = await routeTaskModel(
		service(answers),
		{ ...POLICY_FE, specialtyModels: { frontendDesign: "design/primary" } },
		{ agentName: "planner", assignment: "프로덕션 결제 화면을 되돌릴 수 없게 교체해줘", currentModel: TIERS.fast },
	);

	expect(routed).toMatchObject({ model: TIERS.deep, tier: "deep", requestedSource: "tier" });
	expect(routed?.candidates.some(candidate => candidate.source === "specialty")).toBe(false);
});

test("a specialty selector already inside the role's own chain is attributed to baseline", async () => {
	// The specialty points at the role's *fallback* entry, not its head, so the
	// "already there" check does not fire and composition is what has to be right.
	const routed = await routeTaskModel(
		service(specialtyAnswer("frontendDesign", 0.9, 0.9)),
		{ ...POLICY, specialtyModels: { frontendDesign: "role/secondary" } },
		{
			agentName: "planner",
			assignment: "온보딩 화면 정보구조를 설계하고 컴포넌트 구조를 계획해줘",
			currentModel: "role/primary",
			baselineChain: ["role/primary", "role/secondary"],
		},
	);

	// Resolving that entry would only prove the role's own chain was usable, so it
	// must not be reported as a specialty hit.
	expect(routed?.requestedSource).toBe("tier");
	expect(routed?.candidates.some(candidate => candidate.source === "specialty")).toBe(false);
	expect(routed?.candidates.map(candidate => `${candidate.selector}:${candidate.source}`)).toEqual([
		`${TIERS.balanced}:tier`,
		"role/primary:baseline",
		"role/secondary:baseline",
	]);
});
