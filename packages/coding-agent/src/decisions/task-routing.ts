/**
 * Pick the model a subagent runs on from the work it was handed.
 *
 * A role's configured model is a standing guess about the *average* task that
 * role gets. It cannot be right for every one: the same executor is handed both
 * a one-line rename and a migration across twelve files. This asks about the
 * actual assignment and moves the model when the answer is clear enough.
 *
 * Only subagents. The main loop's model is deliberately out of scope — changing
 * it mid-session invalidates the prompt cache, and on a long context re-caching
 * routinely costs more than the cheaper tier saves. A subagent starts with its
 * own context, so there is nothing to invalidate.
 */
import { logger } from "@sayknow-cli/utils";
import type { DecisionService } from "./index";
import type { Question } from "./types";

/** Ordered cheapest to most capable. The order *is* the policy's direction. */
export const TASK_TIERS = ["fast", "balanced", "deep"] as const;
export type TaskTier = (typeof TASK_TIERS)[number];

export interface TaskTierModels {
	fast?: string;
	balanced?: string;
	deep?: string;
}

export interface TaskRoutingPolicy {
	tiers: TaskTierModels;
	/**
	 * Bar to move to a more capable model. Being wrong costs money.
	 */
	minUpgradeConfidence: number;
	/**
	 * Bar to move to a cheaper model. Being wrong means real work handled by a
	 * model too small for it, which is discovered late and costs a retry — so
	 * this bar sits higher than the upgrade bar on purpose.
	 */
	minDowngradeConfidence: number;
	/**
	 * Model for frontend planning, when the assignment reads as frontend work.
	 *
	 * This is the **domain** axis, not a rung on the ladder: a design-strong model
	 * is not "better" than a code-strong one, it is a different specialty. Only
	 * planning roles ever take it, and only laterally — the implementation roles
	 * stay on the difficulty ladder.
	 */
	frontendModel?: string;
	/**
	 * Bar for the lateral swap above. Directional bars do not apply here because
	 * neither direction is "spending more": being wrong either way costs quality,
	 * symmetrically, so one bar is the whole story.
	 */
	minDomainConfidence: number;
}

export const DEFAULT_TASK_ROUTING_POLICY: Omit<TaskRoutingPolicy, "tiers"> = {
	// Deliberately higher than the reference implementation's 0.3/0.6. That one
	// assumes a frontier default with a cheap tier to fall to, so "up" is the
	// rare move. Here the configured role models are already chosen per role, so
	// overriding one needs a stronger signal in either direction.
	minUpgradeConfidence: 0.5,
	minDowngradeConfidence: 0.75,
	minDomainConfidence: 0.6,
};

/**
 * Roles whose output is a plan or a design review.
 *
 * These are the only roles the domain swap applies to — the user's intent is
 * "a design-strong model *plans* the frontend; implementation stays where it
 * is". Executor keeps the difficulty ladder regardless of domain.
 */
export const PLANNING_ROLES: ReadonlySet<string> = new Set(["planner", "architect"]);

/**
 * The questions describe the *work*, never a model name.
 *
 * Naming models in the criteria would bind the classifier to one lineup and
 * make every model swap a prompt change. It also invites the model to reason
 * about price, which is not what it is good at.
 */
function buildQuestions(): Record<string, Question> {
	return {
		tier: {
			type: "choice",
			instructions: "How demanding is this assignment?",
			criteria: {
				fast: "Mechanical and local. A rename, a typo, a one-file edit, running a command and reporting what it printed.",
				balanced: "Ordinary engineering. Several files, an existing pattern to follow, normal debugging.",
				deep: "Hard or high-stakes. Unclear cause, cross-cutting design, subtle correctness, or work that is hard to undo.",
			},
		},
		risky: {
			type: "noul",
			instructions:
				"Does this assignment touch production, money, credentials, published releases, or state that cannot be undone?",
		},
		domain: {
			type: "noul",
			instructions:
				"Is this assignment frontend/UI work — interfaces, components, visual design, styling or interaction — rather than data, APIs, infrastructure or business logic?",
		},
	};
}

export interface TaskRoutingRequest {
	agentName: string;
	/** The assignment text the subagent will act on. */
	assignment: string;
	/** Whatever the role is configured to use today, used as the direction baseline. */
	currentModel: string | undefined;
	signal?: AbortSignal;
}

export interface TaskRoutingResult {
	model: string;
	/** Null when the move was a domain swap — that axis has no ladder. */
	tier: TaskTier | null;
	reason: string;
}

/** Where a concrete model id sits in the ladder, or null when it is not one of ours. */
function rankOf(model: string | undefined, tiers: TaskTierModels): number | null {
	if (!model) return null;
	const index = TASK_TIERS.findIndex(tier => tiers[tier] && matchesModel(tiers[tier] as string, model));
	return index === -1 ? null : index;
}

/**
 * Compare a configured tier model against the role's current selector.
 *
 * Selectors carry a thinking suffix (`provider/id:high`) that the tier table
 * may or may not repeat, so compare the part before it.
 */
function matchesModel(a: string, b: string): boolean {
	const base = (value: string) => value.split(":")[0]?.trim().toLowerCase() ?? "";
	return base(a) === base(b);
}

/**
 * Is a move from `current` to `wanted` allowed at this confidence?
 *
 * A backend that cannot report a calibrated confidence may only move a request
 * **up**. Spending less on an unmeasured hunch is the bad trade: the upgrade's
 * worst case is an overpriced answer, the downgrade's is a wrong one.
 */
function allowed(
	wanted: number,
	current: number | null,
	confidence: number | undefined,
	calibrated: boolean,
	policy: TaskRoutingPolicy,
): boolean {
	if (current !== null && wanted === current) return false;
	const isDowngrade = current !== null && wanted < current;
	if (!calibrated || confidence === undefined) return !isDowngrade;
	return confidence >= (isDowngrade ? policy.minDowngradeConfidence : policy.minUpgradeConfidence);
}

/**
 * Decide the model for one subagent spawn, or null to leave the configured one alone.
 *
 * Every failure path returns null: no tiers configured, decisions disabled, no
 * backend, a timeout, an answer outside the enum. A subagent that runs on its
 * configured model is the status quo, and the status quo is always acceptable.
 */
export async function routeTaskModel(
	service: DecisionService,
	policy: TaskRoutingPolicy,
	request: TaskRoutingRequest,
): Promise<TaskRoutingResult | null> {
	const configured = TASK_TIERS.filter(tier => policy.tiers[tier]);
	const frontendModel = policy.frontendModel?.trim() || undefined;
	// Neither axis has anything to move on: no ladder and no domain model.
	if (configured.length < 2 && !frontendModel) return null;

	const assignment = request.assignment.trim();
	if (assignment.length < 24) return null;

	const result = await service.decide({
		state: `Agent: ${request.agentName}\n\nAssignment:\n${assignment.slice(0, 4_000)}`,
		questions: buildQuestions(),
		signal: request.signal,
	});
	if (!result) return null;

	// --- Domain axis: lateral swap for planning roles ---
	//
	// A design-strong model is not "more capable" than a code-strong one, so this
	// is not a rung on the ladder and the directional bars do not apply. When the
	// assignment clearly reads as frontend work and a frontend model is
	// configured, planning roles take it — that is the whole of the user's
	// intent: the design model *plans* the frontend, implementation stays put.
	// When the swap fires, the difficulty ladder is skipped entirely for this
	// spawn; for planning, design judgment is the point, not raw capability.
	const domainAnswer = result.answers.domain;
	if (
		frontendModel &&
		PLANNING_ROLES.has(request.agentName) &&
		domainAnswer?.type === "noul" &&
		domainAnswer.noul >= policy.minDomainConfidence
	) {
		if (request.currentModel && matchesModel(frontendModel, request.currentModel)) return null;
		logger.debug("decisions/task-routing: routed", {
			agent: request.agentName,
			model: frontendModel,
			reason: `frontend (domain ${domainAnswer.noul.toFixed(2)})`,
		});
		return {
			model: frontendModel,
			tier: null,
			reason: `frontend (domain ${domainAnswer.noul.toFixed(2)})`,
		};
	}

	// --- Difficulty axis: the ladder ---
	if (configured.length < 2) return null;
	const answer = result.answers.tier;
	if (answer?.type !== "choice") return null;
	let tier = TASK_TIERS.find(candidate => candidate === answer.choice);
	if (!tier) return null;

	// Work that cannot be undone takes the most capable tier available and skips
	// the confidence bars — this one is not a confidence question. It may only
	// ever raise the tier, never lower it, or "this is risky" would end up
	// *downgrading* an assignment already running deep.
	const riskAnswer = result.answers.risky;
	const forcedByRisk = riskAnswer?.type === "noul" && riskAnswer.noul > 0.7;
	if (forcedByRisk) {
		const deepest = configured[configured.length - 1] as TaskTier;
		const currentRank = rankOf(request.currentModel, policy.tiers);
		const wantedRank = Math.max(TASK_TIERS.indexOf(deepest), currentRank ?? 0);
		tier = TASK_TIERS[wantedRank] as TaskTier;
	}

	const model = policy.tiers[tier];
	if (!model || (request.currentModel && matchesModel(model, request.currentModel))) return null;

	const currentRank = rankOf(request.currentModel, policy.tiers);
	const wantedRank = TASK_TIERS.indexOf(tier);
	if (!forcedByRisk && !allowed(wantedRank, currentRank, answer.confidence, result.calibrated, policy)) {
		logger.debug("decisions/task-routing: below the bar, keeping the configured model", {
			agent: request.agentName,
			wanted: tier,
			current: request.currentModel,
			confidence: answer.confidence,
			calibrated: result.calibrated,
		});
		return null;
	}

	const reason = forcedByRisk
		? `${tier}, forced by risk`
		: `${tier} (confidence ${answer.confidence?.toFixed(2) ?? "n/d"})`;
	logger.debug("decisions/task-routing: routed", { agent: request.agentName, model, reason });
	return { model, tier, reason };
}
