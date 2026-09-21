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
