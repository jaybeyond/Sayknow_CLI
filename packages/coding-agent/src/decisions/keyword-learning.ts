/**
 * Self-populating keyword table.
 *
 * The hand-written table in `hooks/skill-keywords.ts` has eighteen literal
 * strings in it and recalled 0/9 on Korean prompts, because nobody can
 * enumerate Korean particle and ending combinations by hand. The semantic stage
 * covers that gap, but it pays a model call every time — including for a
 * phrasing the same user has already routed the same way five times.
 *
 * This module closes the loop: every semantic routing answer is observed here,
 * discriminative two-stem patterns are mined out of it, and a pattern that has
 * proved itself is promoted into the deterministic stage. The next prompt
 * carrying it is answered for free.
 *
 * **What makes this safe.** A keyword fires with full authority and no
 * confidence to fall back on, so a wrong promotion silently switches on the
 * mutation guard and the Stop hook for a user who asked for neither. Every rule
 * below exists to make a wrong promotion hard:
 *
 * - A pattern needs the *same* answer on two or more **distinct** prompts.
 *   Repeating one prompt verbatim proves nothing and is fingerprinted out.
 * - One contradiction destroys it. Appearing in a prompt routed to a different
 *   workflow — or to no workflow at all — blocks the pattern permanently, since
 *   a phrase that shows up on both sides is by definition not discriminative.
 * - Only a calibrated, confident answer counts for the fast promotion path;
 *   an ordinal answer from a constrained LLM needs an extra observation.
 * - Two stems, ordered, with a bounded gap. One stem is a word, and words are
 *   ambiguous; a whole sentence is a cache key, not a rule.
 *
 * **What is stored.** Stems and fingerprint hashes, never prompt text.
 *
 * **Which languages.** Whatever the user writes in. Words are found with the
 * platform's Unicode segmenter, so a Thai, Chinese or Japanese prompt with no
 * spaces mines the same two-stem rules a Korean or English one does, and the
 * rule fires on the same script it was mined from. Nothing here knows which
 * language a prompt is in and nothing needs to.
 */
import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@sayknow-cli/utils";
import type { SkillKeywordDefinition } from "../hooks/skill-keywords";
import { SKC_SKILL_KEYWORD_DEFINITIONS } from "../hooks/skill-keywords";
import type { CanonicalSkcWorkflowSkill } from "../skill-state/active-state";

export const LEARNED_KEYWORD_STORE_VERSION = 1;

/** Distinct prompts a pattern must survive before it fires on its own. */
const PROMOTION_OBSERVATIONS_CALIBRATED = 2;
/**
 * An ordinal confidence from a constrained LLM ranks, it does not measure, so
 * the threshold below is meaningless for it. One more independent prompt is the
 * only evidence that is still worth anything.
 */
const PROMOTION_OBSERVATIONS_ORDINAL = 3;
/** Below this, a calibrated backend is telling you it is guessing. */
const MIN_PROMOTION_CONFIDENCE = 0.9;

/** Characters between the two stems. Wide enough for a particle and an adverb. */
const MAX_STEM_GAP = 16;
/** Only the opening of a prompt carries intent; the rest is payload. */
const MAX_MINED_CHARS = 400;
/** A long prompt would otherwise mine hundreds of pairs, one of which will be noise. */
const MAX_SHINGLES_PER_PROMPT = 48;

const MAX_CANDIDATES = 512;
const MAX_ENTRIES = 128;
/** Enough to prove "distinct prompts" without growing the file per user. */
const MAX_FINGERPRINTS = 8;
/** A candidate nobody has reinforced in a month is noise from a one-off session. */
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Control character 0x01: cannot occur in a mined stem, so the join is unambiguous. */
const STEM_SEPARATOR = String.fromCharCode(1);

/**
 * English function words. They pass the length filter, pair with anything, and
 * would produce patterns like "the … code" that match every prompt ever sent.
 *
 * English only, on purpose: it is the one language whose vocabulary every
 * prompt shares (identifiers, file names, tool output). Function words of any
 * other language stop at the contradiction rule instead — the first ordinary
 * prompt in that language blocks them, since it carries them too.
 */
const ENGLISH_STOPWORDS = new Set([
	"the",
	"and",
	"but",
	"for",
	"with",
	"this",
	"that",
	"there",
	"here",
	"from",
	"into",
	"about",
	"you",
	"your",
	"our",
	"can",
	"could",
	"should",
	"would",
	"will",
	"please",
	"just",
	"have",
	"has",
	"not",
	"are",
	"was",
	"were",
	"its",
	"they",
	"them",
	"then",
	"than",
]);

/**
 * Korean particles and endings, stripped from the tail of a token.
 *
 * This is not morphology — it is the smallest thing that makes the three forms
 * of one noun mine the same stem, which is the entire reason the literal table
 * could not express Korean.
 */
const KOREAN_TAIL_CHARS = new Set([
	"은",
	"는",
	"이",
	"가",
	"을",
	"를",
	"에",
	"서",
	"로",
	"와",
	"과",
	"도",
	"만",
	"의",
	"야",
	"요",
	"죠",
	"줘",
	"자",
	"고",
	"해",
	"했",
	"한",
	"할",
	"함",
	"다",
	"니",
	"까",
	"며",
	"면",
	"지",
	"랑",
	"나",
	"어",
	"아",
	"게",
	"라",
	"습",
	// Syllables that only ever appear inside multi-character particles
	// ("부터", "까지", "으로", "에서"). Without them the same noun mines two
	// different stems and the two prompts never agree on anything.
	"부",
	"터",
	"까",
	"지",
	"으",
]);

const HANGUL_PATTERN = /\p{Script=Hangul}/u;
/**
 * Scripts a regex engine finds no word boundary in. Korean glues its particles
 * onto the noun; Chinese, Japanese and Thai write no spaces at all. A stem from
 * one of these is matched as a bare substring, and one character of it is too
 * little to call a word.
 */
const UNBOUNDED_SCRIPT_PATTERN =
	/[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const SINGLE_HAN_PATTERN = /^\p{Script=Han}$/u;
/**
 * Japanese writes grammar in hiragana and content in kanji or katakana, so a
 * token that is hiragana through and through is a particle, an ending or a
 * politeness marker — "して", "ください", "から". Measured live: without this,
 * two ralplan prompts promoted "って … 承認", and "って" is in every casual
 * request. The script-level rule is the closest thing Japanese has to the
 * English stoplist, and it needs no vocabulary.
 */
const HIRAGANA_ONLY_PATTERN = /^[\p{Script=Hiragana}ー]+$/u;
const LETTER_PATTERN = /\p{L}/u;
/**
 * Splits a segmenter word on the punctuation it keeps inside one: `foo.ts`, `my_var`,
 * `3.5`. Marks stay in — Thai vowels and Devanagari matras are combining characters,
 * not letters, and cutting a word at each of them leaves nothing recognisable.
 */
const WORD_INNER_BREAK_PATTERN = /[^\p{L}\p{M}\p{N}']+/u;
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

interface StoredPattern {
	/** Two stems joined by {@link STEM_SEPARATOR}. */
	readonly stems: string;
	readonly skill: CanonicalSkcWorkflowSkill;
	/** Distinct prompts that produced this answer. */
	positives: number;
	/** Fingerprints already counted, so one prompt cannot promote itself. */
	fingerprints: string[];
	firstSeen: number;
	lastSeen: number;
}

interface LearnedKeywordStore {
	version: number;
	/** Promoted: these fire deterministically. */
	entries: StoredPattern[];
	/** Seen once, or seen with an ordinal answer. Not firing yet. */
	candidates: StoredPattern[];
	/** Proved ambiguous. Never reconsidered — that is the point. */
	blocked: string[];
}

function emptyStore(): LearnedKeywordStore {
	return { version: LEARNED_KEYWORD_STORE_VERSION, entries: [], candidates: [], blocked: [] };
}

let storePathOverride: string | undefined;
let cache: LearnedKeywordStore | undefined;

/** Test seam. Also lets a host keep the table out of the user's home. */
export function setLearnedKeywordStorePath(value: string | undefined): void {
	storePathOverride = value;
	cache = undefined;
}

export function resetLearnedKeywordCache(): void {
	cache = undefined;
}

/**
 * Where the learned table lives.
 *
 * User-global on purpose: a phrasing you use is a phrasing you use, and making it
 * per-repository would mean relearning the same rule in every checkout.
 * `SKC_LEARNED_KEYWORDS_PATH` redirects it, so a test driving a real session under
 * a temp agent dir cannot write into the developer's actual home.
 */
export function getLearnedKeywordStorePath(): string {
	const override = storePathOverride ?? process.env.SKC_LEARNED_KEYWORDS_PATH?.trim();
	return override || path.join(getAgentDir(), "learned-skill-keywords.json");
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

function stemKorean(token: string): string {
	let stem = token;
	// Three strips, floored at two syllables. That is what it takes to collapse a
	// stacked particle ("계획서부터" -> "계획") onto the same stem as the plain one
	// ("계획서를" -> "계획"), and over-stripping is the safe direction: the compiled
	// pattern matches the raw prompt as a substring, so a shorter stem costs
	// precision, which the two-prompt agreement rule then filters, while a longer
	// one costs recall, which nothing recovers.
	for (let strip = 0; strip < 3; strip++) {
		if (stem.length <= 2) break;
		const tail = stem[stem.length - 1];
		if (!tail || !KOREAN_TAIL_CHARS.has(tail)) break;
		stem = stem.slice(0, -1);
	}
	return stem;
}

/**
 * Break text into words in whatever script it is written.
 *
 * `Intl.Segmenter` carries the ICU dictionaries, which is what makes a Thai or
 * Japanese prompt with no spaces come apart into words at all. Its Chinese
 * dictionary misses most technical compounds and hands back one character at
 * a time ("文档" → "文", "档"), so a run of single characters is re-joined into
 * character bigrams — the standard fallback for CJK without a dictionary, and it
 * recovers "文档", "重构" and "模块" at the cost of a few cross-word pairs that
 * the two-prompt rule never promotes.
 */
function segmentWords(text: string): string[] {
	const words: string[] = [];
	let hanRun = "";
	const flushHanRun = () => {
		if (hanRun.length === 1) words.push(hanRun);
		for (let i = 0; i + 1 < hanRun.length; i++) words.push(hanRun.slice(i, i + 2));
		hanRun = "";
	};
	for (const segment of WORD_SEGMENTER.segment(text)) {
		if (!segment.isWordLike) {
			flushHanRun();
			continue;
		}
		if (SINGLE_HAN_PATTERN.test(segment.segment)) {
			hanRun += segment.segment;
			continue;
		}
		flushHanRun();
		for (const part of segment.segment.split(WORD_INNER_BREAK_PATTERN)) if (part) words.push(part);
	}
	flushHanRun();
	return words;
}

/** Normalize to the token stream both mining and fingerprinting agree on. */
function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const raw of segmentWords(text.slice(0, MAX_MINED_CHARS).toLowerCase())) {
		// A path or a bare number is payload, not intent, and would mine a pattern
		// that only ever matches this one repository.
		if (raw.length > 24 || !LETTER_PATTERN.test(raw)) continue;
		if (HANGUL_PATTERN.test(raw)) {
			const stem = stemKorean(raw);
			if (stem.length >= 2) tokens.push(stem);
			continue;
		}
		if (UNBOUNDED_SCRIPT_PATTERN.test(raw)) {
			if (raw.length >= 2 && !HIRAGANA_ONLY_PATTERN.test(raw)) tokens.push(raw);
			continue;
		}
		if (raw.length < 3 || ENGLISH_STOPWORDS.has(raw)) continue;
		tokens.push(raw);
	}
	return tokens;
}

/**
 * Ordered stem pairs within a three-token window.
 *
 * The gap is what makes a learned pattern generalize where the literal table
 * cannot: a prompt that says "make me a plan document" mines `plan … document`,
 * which then also matches "make the plan into a document" — the phrasing that
 * made the hand-written entry miss.
 */
export function mineShingles(text: string): string[] {
	const tokens = tokenize(text);
	const shingles: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		for (let j = i + 1; j <= i + 2 && j < tokens.length; j++) {
			const a = tokens[i];
			const b = tokens[j];
			if (!a || !b || a === b) continue;
			const key = `${a}${STEM_SEPARATOR}${b}`;
			if (seen.has(key)) continue;
			seen.add(key);
			shingles.push(key);
			if (shingles.length >= MAX_SHINGLES_PER_PROMPT) return shingles;
		}
	}
	return shingles;
}

function fingerprint(text: string): string {
	return createHash("sha1").update(tokenize(text).join(" ")).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stemToPattern(stem: string): string {
	const escaped = escapeRegex(stem);
	// A stem from a script without visible word boundaries can only be matched as
	// a bare substring. Every other script gets a real left boundary so "plan"
	// does not match "explanation" — in any alphabet, hence the Unicode classes.
	// The right side stays open on purpose: it is what lets one stem cover every
	// inflection of the same word.
	return UNBOUNDED_SCRIPT_PATTERN.test(stem) ? escaped : `(?<![\\p{L}\\p{N}_])${escaped}`;
}

function compilePattern(stems: string): RegExp | null {
	const [a, b] = stems.split(STEM_SEPARATOR);
	if (!a || !b) return null;
	// Sentence terminators bound the gap: two stems on opposite sides of a full
	// stop are two different thoughts, not one intent. Fullwidth forms included,
	// since that is what a CJK keyboard produces.
	return new RegExp(`${stemToPattern(a)}[^.?!。？！\\n]{0,${MAX_STEM_GAP}}${stemToPattern(b)}`, "iu");
}

function displayKeyword(stems: string): string {
	return stems.split(STEM_SEPARATOR).join(" … ");
}

const MAX_HARDCODED_PRIORITY = Math.max(...SKC_SKILL_KEYWORD_DEFINITIONS.map(definition => definition.priority));

/**
 * Always negative, so a learned pattern loses every tie to an enumerated one
 * while keeping the relative order between workflows. A human who wrote a
 * keyword outranks a rule mined from the user's own history, every time.
 */
function learnedPriorityFor(skill: CanonicalSkcWorkflowSkill): number {
	const base = SKC_SKILL_KEYWORD_DEFINITIONS.find(definition => definition.skill === skill)?.priority ?? 0;
	return base - MAX_HARDCODED_PRIORITY - 1;
}

// ---------------------------------------------------------------------------
// Store IO
// ---------------------------------------------------------------------------

function sanitize(raw: unknown): LearnedKeywordStore {
	if (!raw || typeof raw !== "object") return emptyStore();
	const value = raw as Partial<LearnedKeywordStore>;
	if (value.version !== LEARNED_KEYWORD_STORE_VERSION) return emptyStore();
	const patterns = (input: unknown): StoredPattern[] =>
		Array.isArray(input)
			? input.filter(
					(item): item is StoredPattern =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as StoredPattern).stems === "string" &&
						(item as StoredPattern).stems.includes(STEM_SEPARATOR) &&
						typeof (item as StoredPattern).skill === "string" &&
						Array.isArray((item as StoredPattern).fingerprints),
				)
			: [];
	return {
		version: LEARNED_KEYWORD_STORE_VERSION,
		entries: patterns(value.entries).slice(0, MAX_ENTRIES),
		candidates: patterns(value.candidates).slice(0, MAX_CANDIDATES),
		blocked: Array.isArray(value.blocked) ? value.blocked.filter(item => typeof item === "string") : [],
	};
}

async function readStore(): Promise<LearnedKeywordStore> {
	if (cache) return cache;
	try {
		const file = Bun.file(getLearnedKeywordStorePath());
		cache = (await file.exists()) ? sanitize(await file.json()) : emptyStore();
	} catch (error) {
		// A corrupt or unreadable table must never take down a user's turn; losing
		// what was learned is the correct price.
		logger.debug("decisions/keyword-learning: unreadable store, starting empty", { error: String(error) });
		cache = emptyStore();
	}
	return cache;
}

async function writeStore(store: LearnedKeywordStore): Promise<void> {
	cache = store;
	const target = getLearnedKeywordStorePath();
	const temp = `${target}.${process.pid}.tmp`;
	try {
		// Temp + rename: a concurrent session reading mid-write must never see a
		// half-written file and conclude the table is corrupt.
		await Bun.write(temp, JSON.stringify(store));
		await rename(temp, target);
	} catch (error) {
		logger.debug("decisions/keyword-learning: store write failed", { error: String(error) });
	}
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Promoted patterns, in the shape the deterministic stage consumes.
 *
 * Priority sits one below the hand-written entry for the same workflow: when a
 * learned pattern and an enumerated keyword disagree, the human wins.
 */
export async function loadLearnedKeywordDefinitions(): Promise<SkillKeywordDefinition[]> {
	const store = await readStore();
	const definitions: SkillKeywordDefinition[] = [];
	for (const entry of store.entries) {
		const pattern = compilePattern(entry.stems);
		if (!pattern) continue;
		definitions.push({
			keyword: displayKeyword(entry.stems),
			skill: entry.skill,
			priority: learnedPriorityFor(entry.skill),
			guidance: `Activate SKC ${entry.skill} workflow (learned from ${entry.positives} routed prompts)`,
			pattern,
			learned: true,
		});
	}
	return definitions;
}

/** Stems of `candidate` are all extensions of `existing`'s — same rule, less general. */
function isRedundantWith(existing: StoredPattern, candidate: StoredPattern): boolean {
	if (existing.skill !== candidate.skill) return false;
	const [ea, eb] = existing.stems.split(STEM_SEPARATOR);
	const [ca, cb] = candidate.stems.split(STEM_SEPARATOR);
	if (!ea || !eb || !ca || !cb) return false;
	return ca.startsWith(ea) && cb.startsWith(eb);
}

export interface RoutingObservation {
	text: string;
	/** Null means the router deliberately chose no workflow — a negative example. */
	skill: CanonicalSkcWorkflowSkill | null;
	confidence?: number | undefined;
	calibrated?: boolean | undefined;
}

export interface LearningOutcome {
	promoted: SkillKeywordDefinition[];
	retracted: number;
}

/**
 * Feed one routing answer into the table.
 *
 * Best-effort by construction: it runs after the turn's routing decision is
 * already made, so a failure here changes nothing the user can observe.
 */
export async function observeRouting(observation: RoutingObservation): Promise<LearningOutcome> {
	const outcome: LearningOutcome = { promoted: [], retracted: 0 };
	const shingles = mineShingles(observation.text);
	if (shingles.length === 0) return outcome;

	const store = await readStore();
	const now = Date.now();
	const print = fingerprint(observation.text);
	const blocked = new Set(store.blocked);
	const mined = new Set(shingles);
	let dirty = false;

	// A promoted pattern that appears in a prompt routed elsewhere was never
	// discriminative. Retract it — the cost of leaving it in is a workflow the
	// user did not ask for, every time they use that phrasing.
	const survivingEntries: StoredPattern[] = [];
	for (const entry of store.entries) {
		if (!mined.has(entry.stems)) {
			survivingEntries.push(entry);
			continue;
		}
		if (entry.skill === observation.skill) {
			if (!entry.fingerprints.includes(print)) {
				entry.fingerprints = [print, ...entry.fingerprints].slice(0, MAX_FINGERPRINTS);
				entry.positives++;
			}
			entry.lastSeen = now;
			dirty = true;
			survivingEntries.push(entry);
			continue;
		}
		logger.debug("decisions/keyword-learning: retracting contradicted pattern", {
			stems: displayKeyword(entry.stems),
			had: entry.skill,
			saw: observation.skill ?? "none",
		});
		blocked.add(entry.stems);
		outcome.retracted++;
		dirty = true;
	}
	store.entries = survivingEntries;

	const required =
		observation.calibrated && (observation.confidence ?? 0) >= MIN_PROMOTION_CONFIDENCE
			? PROMOTION_OBSERVATIONS_CALIBRATED
			: PROMOTION_OBSERVATIONS_ORDINAL;

	const survivingCandidates: StoredPattern[] = [];
	for (const candidate of store.candidates) {
		if (blocked.has(candidate.stems)) {
			dirty = true;
			continue;
		}
		if (!mined.has(candidate.stems)) {
			if (now - candidate.lastSeen > CANDIDATE_TTL_MS) {
				dirty = true;
				continue;
			}
			survivingCandidates.push(candidate);
			continue;
		}
		// Seen again, but with a different answer — or with none at all. Either way
		// the stems do not separate the classes, so stop tracking them for good.
		if (candidate.skill !== observation.skill) {
			blocked.add(candidate.stems);
			dirty = true;
			continue;
		}
		dirty = true;
		if (!candidate.fingerprints.includes(print)) {
			candidate.fingerprints = [print, ...candidate.fingerprints].slice(0, MAX_FINGERPRINTS);
			candidate.positives++;
		}
		candidate.lastSeen = now;
		if (candidate.positives < required) {
			survivingCandidates.push(candidate);
			continue;
		}
		// Promotion. A more general pattern already covering this one makes it dead
		// weight; a less general one it covers gets replaced, because the general
		// rule is the one worth keeping.
		if (store.entries.some(entry => isRedundantWith(entry, candidate))) continue;
		store.entries = store.entries.filter(entry => !isRedundantWith(candidate, entry));
		store.entries.unshift(candidate);
		const pattern = compilePattern(candidate.stems);
		if (pattern) {
			outcome.promoted.push({
				keyword: displayKeyword(candidate.stems),
				skill: candidate.skill,
				priority: learnedPriorityFor(candidate.skill),
				guidance: `Activate SKC ${candidate.skill} workflow (learned)`,
				pattern,
				learned: true,
			});
		}
		logger.debug("decisions/keyword-learning: promoted pattern", {
			stems: displayKeyword(candidate.stems),
			skill: candidate.skill,
			positives: candidate.positives,
		});
	}
	store.candidates = survivingCandidates;

	// A "none" answer only ever removes. Opening candidates for it would mine the
	// vocabulary of ordinary coding requests, which is every prompt SKC gets.
	if (observation.skill) {
		const known = new Set([...store.entries, ...store.candidates].map(item => item.stems));
		for (const stems of shingles) {
			if (known.has(stems) || blocked.has(stems)) continue;
			store.candidates.push({
				stems,
				skill: observation.skill,
				positives: 1,
				fingerprints: [print],
				firstSeen: now,
				lastSeen: now,
			});
			dirty = true;
		}
	}

	if (!dirty) return outcome;

	store.blocked = [...blocked].slice(-MAX_CANDIDATES);
	if (store.candidates.length > MAX_CANDIDATES) {
		// Evict the least reinforced first; a high-positive candidate is the one
		// closest to being worth something.
		store.candidates.sort((a, b) => b.positives - a.positives || b.lastSeen - a.lastSeen);
		store.candidates.length = MAX_CANDIDATES;
	}
	if (store.entries.length > MAX_ENTRIES) {
		store.entries.sort((a, b) => b.positives - a.positives || b.lastSeen - a.lastSeen);
		store.entries.length = MAX_ENTRIES;
	}
	await writeStore(store);
	return outcome;
}

export interface LearnedKeywordSummary {
	entries: { keyword: string; skill: CanonicalSkcWorkflowSkill; positives: number; lastSeen: number }[];
	candidates: number;
	blocked: number;
}

/** What the table has actually learned, for `skc` surfaces and tests. */
export async function summarizeLearnedKeywords(): Promise<LearnedKeywordSummary> {
	const store = await readStore();
	return {
		entries: store.entries.map(entry => ({
			keyword: displayKeyword(entry.stems),
			skill: entry.skill,
			positives: entry.positives,
			lastSeen: entry.lastSeen,
		})),
		candidates: store.candidates.length,
		blocked: store.blocked.length,
	};
}
