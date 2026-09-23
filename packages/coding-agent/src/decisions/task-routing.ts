/**
 * Pick the model a subagent runs on from the work it was handed.
 *
 * A role's configured model is a standing guess about the *average* task that
 * role gets. It cannot be right for every one: the same executor is handed both
 * a one-line rename and a migration across twelve files. This asks about the
 * actual assignment and moves the model when the answer is clear enough.
 *
 * Two axes, asked in one call:
 *
 * - **Difficulty** — the fast/balanced/deep ladder. Directional, so moving down
 *   costs more confidence than moving up.
 * - **Specialty** — the kind of work (backend architecture, frontend design,
 *   implementation, test work, review). Lateral, so a single bar applies.
 *
 * Only subagents. The main loop's model is deliberately out of scope — changing
 * it mid-session invalidates the prompt cache, and on a long context re-caching
 * routinely costs more than the cheaper tier saves. A subagent starts with its
 * own context, so there is nothing to invalidate.
 */
import { logger } from "@sayknow-cli/utils";
import type { ModelSelectorValue } from "../config/model-selector-value";
import type { Settings } from "../config/settings";
import {
	dedupeRoutingCandidates,
	isTaskModelSpecialty,
	specialtySelectorHead,
	specialtySupportsRole,
	TASK_MODEL_SPECIALTY_IDS,
	TASK_MODEL_SPECIALTY_NONE,
	TASK_MODEL_SPECIALTY_ROLES,
	type TaskModelSpecialty,
	type TaskRoutingCandidate,
	type TaskRoutingSource,
	toRoutingCandidates,
} from "../config/task-model-specialties";
import type { DecisionService } from "./index";
import type { Answer, Question } from "./types";

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
	 * Superseded by `specialtyModels.frontendDesign`; kept as the fallback source
	 * so an existing configuration keeps working untouched until it is migrated.
	 */
	frontendModel?: string;
	/**
	 * Per-specialty models — the work-kind axis.
	 *
	 * Absent entries inherit the role's own chain, which is why an unset specialty
	 * is not an error and does not suppress the difficulty ladder.
	 */
	specialtyModels?: Partial<Record<TaskModelSpecialty, ModelSelectorValue>>;
	/**
	 * Bar for a lateral swap on a **calibrated** backend. Directional bars do not
	 * apply here because neither direction is "spending more": being wrong either
	 * way costs quality, symmetrically, so one bar is the whole story.
	 */
	minDomainConfidence: number;
	/**
	 * Bar for a lateral swap on an **uncalibrated** backend.
	 *
	 * The ordinary logged-in model cannot report a probability, and asking it for
	 * one measurably degrades the answer, so its choice carries no `confidence`.
	 * What it *can* report is an ordinal strength. Requiring a high ordinal is not
	 * the same guarantee as a calibrated threshold, and the result is recorded as
	 * uncalibrated — but refusing to route at all would make a user's explicit
	 * specialty selection silently inert on the default backend.
	 */
	minSpecialtyOrdinal: number;
}

export const DEFAULT_TASK_ROUTING_POLICY: Omit<TaskRoutingPolicy, "tiers"> = {
	// Deliberately higher than the reference implementation's 0.3/0.6. That one
	// assumes a frontier default with a cheap tier to fall to, so "up" is the
	// rare move. Here the configured role models are already chosen per role, so
	// overriding one needs a stronger signal in either direction.
	minUpgradeConfidence: 0.5,
	minDowngradeConfidence: 0.75,
	minDomainConfidence: 0.6,
	// One step above "probably yes" on the ordinal ladder the uncalibrated backend
	// emits, so "unclear" and "probably yes" both decline.
	minSpecialtyOrdinal: 0.75,
};

/**
 * The settings surface this module reads.
 *
 * Narrowed to `get` so the router cannot quietly start writing settings, and so
 * a caller only has to supply a reader rather than a whole `Settings` instance.
 */
export type TaskRoutingSettingsReader = Pick<Settings, "get">;

/** True when the value names at least one model rather than being blank. */
function hasConfiguredModel(value: ModelSelectorValue | undefined): boolean {
	if (Array.isArray(value)) return value.some(entry => entry.trim().length > 0);
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build the routing policy from settings, or null when routing must not run.
 *
 * Null is returned for two distinct reasons that both mean "leave the configured
 * model alone": the feature is off, or it is on but nothing is configured to
 * route *to*. A lone tier is not an axis — there is nowhere to move from it —
 * so two tiers is the floor unless a specialty or the legacy frontend model
 * supplies a lateral target instead.
 */
export function buildTaskRoutingPolicyFromSettings(settings: TaskRoutingSettingsReader): TaskRoutingPolicy | null {
	if (!settings.get("task.modelRouting.enabled")) return null;
	const tiers: TaskTierModels = {
		fast: settings.get("task.modelRouting.fastModel") || undefined,
		balanced: settings.get("task.modelRouting.balancedModel") || undefined,
		deep: settings.get("task.modelRouting.deepModel") || undefined,
	};
	const frontendModel = settings.get("task.modelRouting.frontendModel") || undefined;
	const specialtyModels = settings.get("task.modelRouting.specialtyModels") ?? {};
	const hasSpecialty = TASK_MODEL_SPECIALTY_IDS.some(id => hasConfiguredModel(specialtyModels[id]));
	const tierCount = Object.values(tiers).filter(Boolean).length;
	if (tierCount < 2 && !frontendModel && !hasSpecialty) return null;
	return { ...DEFAULT_TASK_ROUTING_POLICY, tiers, frontendModel, specialtyModels };
}

/**
 * Roles whose output is a plan or a design review.
 *
 * Derived from the specialty compatibility map so the two never drift apart.
 */
export const PLANNING_ROLES: ReadonlySet<string> = new Set(TASK_MODEL_SPECIALTY_ROLES.frontendDesign);

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
		specialty: {
			type: "choice",
			instructions: "Which kind of work is this assignment?",
			criteria: {
				backendArchitecture:
					"Designing or reviewing backend structure: APIs, data models, services, storage, infrastructure.",
				frontendDesign:
					"Designing or reviewing an interface: layout, visual design, interaction, components, styling.",
				implementation:
					"Writing or changing code against an established pattern, where the approach is already settled.",
				testing: "Designing, writing, debugging or running tests and verification.",
				review: "Judging existing work for correctness, regressions, or maintainability.",
				[TASK_MODEL_SPECIALTY_NONE]:
					"General, mixed, or unclear work that does not sit in exactly one of the categories above.",
			},
		},
		specialtyClear: {
			type: "noul",
			instructions:
				"Does this assignment clearly belong to exactly one of those kinds of work, rather than spanning several or being unclear?",
		},
	};
}

export interface TaskRoutingRequest {
	agentName: string;
	/** The assignment text the subagent will act on. */
	assignment: string;
	/** Whatever the role is configured to use today, used as the direction baseline. */
	currentModel: string | undefined;
	/**
	 * The role's fully resolved chain, in order. The composed candidate list ends
	 * with this, so a specialty or tier that cannot be authenticated falls through
	 * to the model the role would have used anyway.
	 */
	baselineChain?: readonly string[];
	signal?: AbortSignal;
}

export interface TaskRoutingResult {
	/** Head of the composed chain — what the spawn runs on if it authenticates. */
	model: string;
	/** Null when the move was a specialty swap — that axis has no ladder. */
	tier: TaskTier | null;
	reason: string;
	/** Ordered, provenance-tagged chain for the existing auth-aware resolver. */
	candidates: TaskRoutingCandidate[];
	/** What the classifier asked for. The *effective* source is only known after resolution. */
	requestedSource: TaskRoutingSource;
	requestedSpecialty?: TaskModelSpecialty;
	requestedTier?: TaskTier;
	/**
	 * True when the caller named the specialty on the spawn itself. No classifier
	 * ran, so `calibrated`/`confidence`/`ordinalStrength` describe nothing here.
	 */
	declared: boolean;
	/** False means `ordinalStrength` ranks, and no probability was available. */
	calibrated: boolean;
	confidence?: number;
	ordinalStrength?: number;
}

export interface DeclaredSpecialtyRequest {
	agentName: string;
	specialty: TaskModelSpecialty;
	/** Whatever the role is configured to use today. */
	currentModel: string | undefined;
	/** The role's fully resolved chain; always the tail so a dead specialty model falls through. */
	baselineChain?: readonly string[];
}

/**
 * Route a spawn whose caller *declared* the kind of work.
 *
 * This is the deterministic half of the specialty axis. Nothing here asks a
 * classifier, reads `task.modelRouting.enabled`, or applies a confidence bar:
 * the user put a model on this specialty in `/model`, the caller says this is
 * that work, and the only remaining reason not to run on it is that it fails —
 * which the child session's fallback chain handles at the transport boundary
 * (429, 5xx, auth, quota) by advancing to the role's baseline behind it.
 *
 * Role eligibility is deliberately not checked. The menu groups specialties
 * under the roles that usually do that work, but the setting is one flat map:
 * a frontend model the user chose for design is the same frontend model they
 * expect when the *implementation* of that frontend is delegated. Refusing
 * here would make "frontend uses a different model" false for exactly the
 * spawns where it matters most.
 *
 * Returns null only when nothing is configured for the specialty, or when the
 * configured model is already what the role would run on anyway.
 */
export function resolveDeclaredSpecialtyRouting(
	settings: TaskRoutingSettingsReader,
	request: DeclaredSpecialtyRequest,
): TaskRoutingResult | null {
	const specialtyModels = settings.get("task.modelRouting.specialtyModels") ?? {};
	const configured = specialtyModels[request.specialty];
	let value: ModelSelectorValue | undefined;
	let source: Extract<TaskRoutingSource, "specialty" | "legacy-frontend"> = "specialty";
	if (hasConfiguredModel(configured)) {
		value = configured;
	} else if (request.specialty === "frontendDesign") {
		// Legacy compatibility: the old single frontend selector still answers for
		// frontend design when no explicit entry has replaced it.
		const legacy = settings.get("task.modelRouting.frontendModel")?.trim();
		if (legacy) {
			value = legacy;
			source = "legacy-frontend";
		}
	}
	if (value === undefined) return null;

	const specialtyCandidates = toRoutingCandidates(value, source, { specialty: request.specialty });
	const head = specialtyCandidates[0];
	if (!head) return null;
	// Already there: the declared model is the role's own. Reporting a route would
	// claim a swap that never happened.
	if (request.currentModel && matchesModel(head.selector, request.currentModel)) return null;

	const candidates = dedupeRoutingCandidates([specialtyCandidates, baselineCandidates(request)]);
	const effectiveHead = candidates[0];
	if (!effectiveHead || effectiveHead.source === "baseline") return null;
	const label = source === "legacy-frontend" ? "frontendDesign (legacy selector)" : request.specialty;
	const reason = `${label}, declared by caller`;
	logger.debug("decisions/task-routing: routed", { agent: request.agentName, model: effectiveHead.selector, reason });
	return {
		model: effectiveHead.selector,
		tier: null,
		reason,
		candidates,
		requestedSource: source,
		requestedSpecialty: request.specialty,
		declared: true,
		calibrated: false,
	};
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
	return specialtySelectorHead(a) === specialtySelectorHead(b);
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

/** The role's own chain, used as the tail of every composed candidate list. */
function baselineCandidates(
	request: Pick<TaskRoutingRequest, "baselineChain" | "currentModel">,
): TaskRoutingCandidate[] {
	const chain = request.baselineChain?.length ? request.baselineChain : [request.currentModel ?? ""];
	return toRoutingCandidates([...chain], "baseline");
}

interface SpecialtySelection {
	specialty: TaskModelSpecialty;
	source: Extract<TaskRoutingSource, "specialty" | "legacy-frontend">;
	value: ModelSelectorValue;
	ordinalStrength?: number;
	confidence?: number;
}

/**
 * Resolve the specialty axis, or null to leave it to the difficulty ladder.
 *
 * Declines are deliberately quiet and numerous: an unrecognized option, `none`,
 * an incompatible role, no configured model, a below-bar answer, or a missing
 * clarity signal all mean "the user did not ask for this, carry on".
 */
function resolveSpecialty(
	policy: TaskRoutingPolicy,
	request: TaskRoutingRequest,
	answers: Record<string, Answer>,
	calibrated: boolean,
): SpecialtySelection | null {
	const answer = answers.specialty;
	if (answer?.type !== "choice") return null;
	const choice = answer.choice;
	if (typeof choice !== "string" || choice === TASK_MODEL_SPECIALTY_NONE) return null;
	if (!isTaskModelSpecialty(choice)) return null;
	if (!specialtySupportsRole(choice, request.agentName)) return null;

	const clarity = answers.specialtyClear;
	const ordinalStrength = clarity?.type === "noul" && typeof clarity.noul === "number" ? clarity.noul : undefined;
	const confidence = typeof answer.confidence === "number" ? answer.confidence : undefined;

	if (calibrated) {
		// A calibrated backend reports a real probability; threshold on it directly.
		if (confidence === undefined || confidence < policy.minDomainConfidence) return null;
	} else {
		// No probability is available. Require an explicit high ordinal instead, and
		// never dress that number up as confidence downstream.
		if (ordinalStrength === undefined || ordinalStrength < policy.minSpecialtyOrdinal) return null;
	}

	const configured = policy.specialtyModels?.[choice];
	if (configured !== undefined && (typeof configured !== "string" || configured.trim().length > 0)) {
		return { specialty: choice, source: "specialty", value: configured, ordinalStrength, confidence };
	}
	// Legacy compatibility: the old single frontend selector still answers for
	// frontend design when no explicit entry has replaced it.
	const legacy = policy.frontendModel?.trim();
	if (choice === "frontendDesign" && legacy) {
		return { specialty: choice, source: "legacy-frontend", value: legacy, ordinalStrength, confidence };
	}
	return null;
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
	const hasSpecialtyModels = TASK_MODEL_SPECIALTY_IDS.some(id => {
		const value = policy.specialtyModels?.[id];
		return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0;
	});
	// No axis has anything to move on: no ladder, no specialty model, no legacy one.
	if (configured.length < 2 && !frontendModel && !hasSpecialtyModels) return null;

	const assignment = request.assignment.trim();
	if (assignment.length < 24) return null;

	const result = await service.decide({
		state: `Agent: ${request.agentName}\n\nAssignment:\n${assignment.slice(0, 4_000)}`,
		questions: buildQuestions(),
		signal: request.signal,
	});
	if (!result) return null;

	const answers = result.answers;
	const baseline = baselineCandidates(request);

	// --- Risk floor ---
	//
	// Work that cannot be undone takes the most capable tier available and skips
	// the confidence bars — this one is not a confidence question. It may only
	// ever raise the tier, never lower it, or "this is risky" would end up
	// *downgrading* an assignment already running deep. It also outranks the
	// specialty axis: a design-strong model is not the safety property being
	// asked for here.
	const riskAnswer = answers.risky;
	const forcedByRisk = riskAnswer?.type === "noul" && typeof riskAnswer.noul === "number" && riskAnswer.noul > 0.7;

	const tierAnswer = answers.tier;
	const declaredTier =
		tierAnswer?.type === "choice" ? TASK_TIERS.find(candidate => candidate === tierAnswer.choice) : undefined;
	const tierConfidence =
		tierAnswer?.type === "choice" && typeof tierAnswer.confidence === "number" ? tierAnswer.confidence : undefined;

	if (forcedByRisk && configured.length > 0) {
		const deepest = configured[configured.length - 1] as TaskTier;
		const currentRank = rankOf(request.currentModel, policy.tiers);
		const wantedRank = Math.max(TASK_TIERS.indexOf(deepest), currentRank ?? 0);
		const tier = TASK_TIERS[wantedRank] as TaskTier;
		const model = policy.tiers[tier];
		if (!model || (request.currentModel && matchesModel(model, request.currentModel))) return null;
		const candidates = dedupeRoutingCandidates([toRoutingCandidates(model, "tier", { tier }), baseline]);
		const head = candidates[0];
		if (!head) return null;
		const reason = `${tier}, forced by risk`;
		logger.debug("decisions/task-routing: routed", { agent: request.agentName, model: head.selector, reason });
		return {
			model: head.selector,
			tier,
			reason,
			candidates,
			requestedSource: "tier",
			requestedTier: tier,
			declared: false,
			calibrated: result.calibrated,
			confidence: tierConfidence,
		};
	}

	// --- Specialty axis: lateral swap for the kind of work ---
	const specialty = resolveSpecialty(policy, request, answers, result.calibrated);
	if (specialty) {
		const specialtyCandidates = toRoutingCandidates(specialty.value, specialty.source, {
			specialty: specialty.specialty,
		});
		const head = specialtyCandidates[0];
		// Already there: nothing to move, and the ladder should not fire either —
		// the user's specialty choice is the standing answer for this work.
		if (head && request.currentModel && matchesModel(head.selector, request.currentModel)) return null;
		if (head) {
			// The tier is still worth composing *behind* the specialty: if the specialty
			// model cannot be authenticated, the difficulty answer is the next best guess.
			const tierSegment =
				declaredTier && policy.tiers[declaredTier]
					? toRoutingCandidates(policy.tiers[declaredTier] as string, "tier", { tier: declaredTier })
					: [];
			const candidates = dedupeRoutingCandidates([specialtyCandidates, tierSegment, baseline]);
			const effectiveHead = candidates[0];
			if (effectiveHead && effectiveHead.source !== "baseline") {
				const strength = result.calibrated
					? `confidence ${specialty.confidence?.toFixed(2) ?? "n/d"}`
					: `clarity ${specialty.ordinalStrength?.toFixed(2) ?? "n/d"}, uncalibrated`;
				const label =
					specialty.source === "legacy-frontend" ? "frontendDesign (legacy selector)" : specialty.specialty;
				const reason = `${label} (${strength})`;
				logger.debug("decisions/task-routing: routed", {
					agent: request.agentName,
					model: effectiveHead.selector,
					reason,
				});
				return {
					model: effectiveHead.selector,
					tier: null,
					reason,
					candidates,
					requestedSource: specialty.source,
					requestedSpecialty: specialty.specialty,
					requestedTier: declaredTier,
					declared: false,
					calibrated: result.calibrated,
					confidence: result.calibrated ? specialty.confidence : undefined,
					ordinalStrength: result.calibrated ? undefined : specialty.ordinalStrength,
				};
			}
		}
	}

	// --- Difficulty axis: the ladder ---
	if (configured.length < 2) return null;
	if (!declaredTier) return null;
	const tier = declaredTier;

	const model = policy.tiers[tier];
	if (!model || (request.currentModel && matchesModel(model, request.currentModel))) return null;

	const currentRank = rankOf(request.currentModel, policy.tiers);
	const wantedRank = TASK_TIERS.indexOf(tier);
	if (!allowed(wantedRank, currentRank, tierConfidence, result.calibrated, policy)) {
		logger.debug("decisions/task-routing: below the bar, keeping the configured model", {
			agent: request.agentName,
			wanted: tier,
			current: request.currentModel,
			confidence: tierConfidence,
			declared: false,
			calibrated: result.calibrated,
		});
		return null;
	}

	const candidates = dedupeRoutingCandidates([toRoutingCandidates(model, "tier", { tier }), baseline]);
	const head = candidates[0];
	if (!head) return null;
	const reason = `${tier} (confidence ${tierConfidence?.toFixed(2) ?? "n/d"})`;
	logger.debug("decisions/task-routing: routed", { agent: request.agentName, model: head.selector, reason });
	return {
		model: head.selector,
		tier,
		reason,
		candidates,
		requestedSource: "tier",
		requestedTier: tier,
		declared: false,
		calibrated: result.calibrated,
		confidence: tierConfidence,
	};
}
