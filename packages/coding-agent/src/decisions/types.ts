/**
 * Typed decisions — "Jev-shaped" structured judgments for code to branch on.
 *
 * The request/response shape follows TypeSafe's System One API so a backend can be
 * swapped without touching call sites: the hosted `jev` model, a self-hosted OpenJev
 * daemon, or — the default — the model the user is already logged into.
 *
 * What this is NOT: a probability oracle. Only the hosted model returns calibrated
 * probabilities. Backends that constrain an ordinary LLM return an ordinal value and
 * report `calibrated: false`; treat those numbers as a ranking, never as P(correct).
 */

/** Pick exactly one option from a closed set. */
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	/** option id -> what that option means. At least two. */
	criteria: Record<string, string>;
}

/** Rate the state against ordered levels. Level 0 is the lowest. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	/** Ordered level descriptions, lowest first. At least two. */
	criteria: string[];
}

/** Is this statement true of the state? */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
	type: "choice";
	/** The selected option id. Always one of the declared `criteria` keys. */
	choice: string;
	/** Present only when the backend exposes a distribution. */
	probabilities?: Record<string, number>;
}

export interface ScoreAnswer {
	type: "score";
	/** Level index. Fractional only when the backend returns a distribution. */
	score: number;
	/** Selected level index. */
	level: number;
	legend: Record<string, string>;
	probabilities?: Record<string, number>;
}

export interface NoulAnswer {
	type: "noul";
	/** 0 (no) .. 1 (yes). Ordinal unless `calibrated` is true. */
	noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface DecisionResult {
	answers: Record<string, Answer>;
	/** Which backend answered, for logging and A/B comparison. */
	backend: string;
	/** Model identifier the backend used. */
	model: string;
	/**
	 * False means the numbers are ordinal rankings, not probabilities.
	 * Only the hosted System One model reports true.
	 */
	calibrated: boolean;
	durationMs: number;
}

export interface DecisionRequest {
	/** The content to judge. Plain text, or JSON-serialisable structured state. */
	state: string | Record<string, unknown> | unknown[];
	/** Question id -> question. Answers come back under the same ids. */
	questions: Record<string, Question>;
	signal?: AbortSignal;
}

export interface DecisionBackend {
	readonly name: string;
	/** Resolves null when the backend is unavailable (no credentials, offline, disabled). */
	decide(request: DecisionRequest): Promise<DecisionResult | null>;
}

export const MIN_OPTIONS = 2;
/** Matches OpenJev's letter-slot ceiling so a graph stays portable across backends. */
export const MAX_OPTIONS = 16;

export function validateQuestions(questions: Record<string, Question>): void {
	const entries = Object.entries(questions);
	if (entries.length === 0) throw new Error("decisions: questions must not be empty");
	for (const [key, question] of entries) {
		if (question.type === "noul") {
			if (!question.instructions?.trim()) throw new Error(`decisions: ${key} needs instructions`);
			continue;
		}
		const size = question.type === "choice" ? Object.keys(question.criteria).length : question.criteria.length;
		if (size < MIN_OPTIONS || size > MAX_OPTIONS)
			throw new Error(`decisions: ${key} needs ${MIN_OPTIONS}-${MAX_OPTIONS} options, got ${size}`);
	}
}

export function stateToText(state: DecisionRequest["state"]): string {
	return typeof state === "string" ? state : JSON.stringify(state);
}
