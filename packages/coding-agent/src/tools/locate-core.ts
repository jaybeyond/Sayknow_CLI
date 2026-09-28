import * as path from "node:path";
import type { ChoiceQuestion, DecisionRequest, DecisionResult, NoulQuestion } from "../decisions/types";

/**
 * Find where behaviour lives by asking Jev, the way `jevgrep` does, but inside SKC and
 * without shipping source bodies: a folder is judged from its path and the names of the
 * files in it; a file is judged from its path and its declaration lines (signatures),
 * never its function bodies or comments.
 *
 * The walk narrows before it widens: large folders are split and only the subfolders Jev
 * rates plausible are entered, so a question about the broker never uploads the TUI.
 */

export interface LocateParams {
	query: string;
	/** Absolute search root. */
	root: string;
	/** Most files to return. */
	limit: number;
}

export interface LocateDeps {
	/** Source files under the root, relative, `/`-separated. */
	listFiles(root: string, signal?: AbortSignal): Promise<string[]>;
	/** Declaration lines of one file (`{ line, text }`), empty when none can be extracted. */
	outline(absolutePath: string, signal?: AbortSignal): Promise<OutlineLine[]>;
	/** One Jev request. Null means the request failed or no key is configured. */
	decide(request: DecisionRequest): Promise<DecisionResult | null>;
	/**
	 * Full text of a file for the local keyword score. Read and scored on this machine only;
	 * nothing from it is sent. Undefined when a file cannot or should not be read.
	 */
	readText?(absolutePath: string): Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface OutlineLine {
	line: number;
	text: string;
}

export interface LocatedFile {
	path: string;
	score: number;
	outline: OutlineLine[];
	/** Below {@link FILE_BAR}: a lead worth a glance, not a confident match. */
	weak?: boolean;
}

export interface LocateResult {
	files: LocatedFile[];
	/** Best-scoring files when none cleared the bar, so the caller still has leads. */
	weakLeads: LocatedFile[];
	foldersJudged: number;
	filesJudged: number;
	requests: number;
	failedRequests: number;
	/** Files considered at all after the folder walk (before any cap). */
	candidates: number;
	truncated: boolean;
	durationMs: number;
}

/** A folder with at most this many files underneath is not split further; its files are judged directly. */
export const LEAF_FOLDER_FILES = 40;
const FOLDERS_PER_REQUEST = 12;
const FILES_PER_REQUEST = 8;
/**
 * Folders are kept relative to the best sibling at the same depth: Jev's folder scores
 * separate well at the top (0.8 for the right one) but leave a long 0.25-0.5 tail that an
 * absolute bar lets through, which multiplies the files judged next.
 */
const FOLDER_FLOOR = 0.35;
const FOLDER_RELATIVE = 0.55;
/** Always follow this many best folders per depth (if they clear {@link FOLDER_MIN}), so a flat score spread never dead-ends. */
const FOLDERS_ALWAYS_KEPT = 2;
const FOLDER_MIN = 0.2;
/** Extra folders per depth entered on the local keyword score despite a low Jev score. */
const LEXICAL_FOLDERS_KEPT = 2;
/** Files with the strongest local keyword score, always judged even if their folder was not entered. */
const LEXICAL_FILES_KEPT = 12;
/** Weight of the local keyword score (0..1) added to Jev's score for ranking. */
const LEXICAL_WEIGHT = 0.3;
/** Priority of files sitting directly in the search root. */
const ROOT_FILE_PRIORITY = 0.5;
export const FILE_BAR = 0.5;
/** Files between this and {@link FILE_BAR} fill the remaining slots, marked weak. */
export const WEAK_FILE_BAR = 0.3;
/** Hard ceilings so one question can never turn into an unbounded bill. */
export const MAX_REQUESTS = 100;
const MAX_CANDIDATE_FILES = 480;
const MAX_FOLDER_DEPTH = 8;
const FILE_NAMES_PER_FOLDER = 14;
const OUTLINE_CHARS_PER_FILE = 2_000;
const CONCURRENCY = 8;

interface Folder {
	path: string;
	files: string[];
	children: Set<string>;
	total: number;
}

function buildTree(files: string[]): Map<string, Folder> {
	const folders = new Map<string, Folder>();
	const folder = (dir: string): Folder => {
		let entry = folders.get(dir);
		if (!entry) {
			entry = { path: dir, files: [], children: new Set(), total: 0 };
			folders.set(dir, entry);
			if (dir !== "") folder(parentOf(dir)).children.add(dir);
		}
		return entry;
	};
	folder("");
	for (const file of files) {
		const dir = parentOf(file);
		folder(dir).files.push(file);
		for (let current = dir; ; current = parentOf(current)) {
			folder(current).total += 1;
			if (current === "") break;
		}
	}
	return folders;
}

const STOP_WORDS = new Set(
	"the and for with from that this into when which what where does each only than then have will should would could their there about after before other while used uses using".split(
		" ",
	),
);

/** Query terms for lexical hints: lowercase words of 4+ letters, cut to a 5-letter stem. */
export function queryTerms(query: string): string[] {
	const words = query.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
	return [...new Set(words.filter(word => !STOP_WORDS.has(word)).map(word => word.slice(0, 5)))];
}

/** How many query terms appear in `text`, with camelCase and snake_case identifiers split into words. */
export function termHits(text: string, terms: readonly string[]): number {
	if (terms.length === 0) return 0;
	const words = text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	let hits = 0;
	for (const term of terms) if (words.some(word => word.startsWith(term))) hits += 1;
	return hits;
}

/**
 * Local keyword score per file, 0..1: IDF-weighted query terms present in the file's own
 * text (identifiers split into words), normalised to the best file. Uses comments and
 * strings too, since none of it leaves the machine.
 */
async function lexicalScores(
	root: string,
	files: readonly string[],
	terms: readonly string[],
	readText: (absolutePath: string) => Promise<string | undefined>,
): Promise<Map<string, number>> {
	const scores = new Map<string, number>();
	if (terms.length === 0) return scores;
	const present = new Map<string, Set<string>>();
	await inParallel([...files], 32, async file => {
		const text = await readText(path.join(root, file)).catch(() => undefined);
		if (!text) return;
		const words = `${file} ${text}`
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/);
		const found = new Set<string>();
		for (const word of words) {
			if (word.length < 4) continue;
			const stem = word.slice(0, 5);
			if (terms.includes(stem)) found.add(stem);
		}
		if (found.size > 0) present.set(file, found);
	});
	const total = Math.max(1, files.length);
	const idf = new Map(
		terms.map(term => [term, Math.log(total / (1 + [...present.values()].filter(set => set.has(term)).length))]),
	);
	let best = 0;
	for (const [file, found] of present) {
		const score = [...found].reduce((sum, term) => sum + Math.max(0, idf.get(term)!), 0);
		scores.set(file, score);
		best = Math.max(best, score);
	}
	if (best > 0) for (const [file, score] of scores) scores.set(file, score / best);
	return scores;
}

function parentOf(relative: string): string {
	const dir = path.posix.dirname(relative);
	return dir === "." ? "" : dir;
}

function allFilesUnder(folders: Map<string, Folder>, dir: string): string[] {
	const folder = folders.get(dir);
	if (!folder) return [];
	return [...folder.files, ...[...folder.children].flatMap(child => allFilesUnder(folders, child))];
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function inParallel<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function locateCode(params: LocateParams, deps: LocateDeps): Promise<LocateResult> {
	const started = Date.now();
	const terms = queryTerms(params.query);
	const allFiles = await deps.listFiles(params.root, deps.signal);
	const folders = buildTree(allFiles);
	const lexical = deps.readText
		? await lexicalScores(params.root, allFiles, terms, deps.readText)
		: new Map<string, number>();
	const lex = (file: string) => lexical.get(file) ?? 0;
	/** Best local keyword score of any file under a folder. */
	const folderLexical = new Map<string, number>();
	for (const [file, score] of lexical) {
		for (let dir = parentOf(file); ; dir = parentOf(dir)) {
			folderLexical.set(dir, Math.max(folderLexical.get(dir) ?? 0, score));
			if (dir === "") break;
		}
	}
	let requests = 0;
	let failedRequests = 0;
	let foldersJudged = 0;
	let truncated = false;

	const request = async (
		state: string,
		questions: Record<string, NoulQuestion | ChoiceQuestion>,
		reserved = false,
	): Promise<DecisionResult | null> => {
		if (deps.signal?.aborted) return null;
		// The final rerank has its own slot so a walk that used the whole budget still gets it.
		if (requests >= MAX_REQUESTS + (reserved ? 1 : 0)) {
			truncated = true;
			return null;
		}
		requests += 1;
		let result: DecisionResult | null;
		try {
			result = await deps.decide({ state, questions, signal: deps.signal });
		} catch {
			// A timed-out or dropped request is a failed judgement, not a failed search.
			result = null;
		}
		if (!result) failedRequests += 1;
		return result;
	};
	const ask = async (state: string, questions: Record<string, NoulQuestion>): Promise<Map<string, number> | null> => {
		const result = await request(state, questions);
		if (!result) return null;
		const scores = new Map<string, number>();
		for (const [key, answer] of Object.entries(result.answers)) {
			if (answer.type === "noul") scores.set(key, answer.noul);
		}
		return scores;
	};

	// --- Folder walk: split big folders, enter only plausible subfolders ---------------
	/** Candidate file -> priority (the score of the folder it came from). */
	const candidates = new Map<string, number>();
	const folderScore = new Map<string, number>([["", ROOT_FILE_PRIORITY]]);
	const addCandidate = (file: string, folderPriority: number) => {
		// A path that names the question's words goes ahead of its folder-mates under the cap.
		const priority = folderPriority + 0.1 * Math.min(2, termHits(file, terms)) + 0.5 * lex(file);
		if ((candidates.get(file) ?? -1) < priority) candidates.set(file, priority);
	};
	let frontier = [""];
	for (let depth = 0; frontier.length > 0 && depth < MAX_FOLDER_DEPTH; depth++) {
		const toJudge: Folder[] = [];
		for (const dir of frontier) {
			const folder = folders.get(dir)!;
			const priority = folderScore.get(dir) ?? ROOT_FILE_PRIORITY;
			if (folder.total <= LEAF_FOLDER_FILES) {
				for (const file of allFilesUnder(folders, dir)) addCandidate(file, priority);
				continue;
			}
			// A big folder's own files are judged by content later; its subfolders are judged here.
			for (const file of folder.files) addCandidate(file, priority);
			for (const child of folder.children) toJudge.push(folders.get(child)!);
		}
		const levelScores: Array<{ path: string; score: number }> = [];
		const batches = chunk(toJudge, FOLDERS_PER_REQUEST);
		const answered = await inParallel(batches, CONCURRENCY, async batch => {
			const listing = batch
				.map(folder => {
					const names = folder.files.slice(0, FILE_NAMES_PER_FOLDER).map(file => path.posix.basename(file));
					const children = [...folder.children].map(child => `${path.posix.basename(child)}/`);
					const shown = [...children.slice(0, 6), ...names].join(", ");
					return `- ${folder.path}/ (${folder.total} files): ${shown}`;
				})
				.join("\n");
			const questions: Record<string, NoulQuestion> = {};
			batch.forEach((folder, index) => {
				questions[`f${index}`] = {
					type: "noul",
					instructions: `Could code that answers the question live under "${folder.path}/"? Judge only from the folder path and the names listed for it.`,
				};
			});
			const scores = await ask(`Question: ${params.query}\n\nFolders:\n${listing}`, questions);
			return { batch, scores };
		});
		for (const { batch, scores } of answered) {
			foldersJudged += batch.length;
			batch.forEach((folder, index) => {
				// A failed request keeps its folders at a middling score: an unknown is not a no.
				levelScores.push({ path: folder.path, score: scores ? (scores.get(`f${index}`) ?? 0) : FOLDER_FLOOR });
			});
		}
		levelScores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		const best = levelScores[0]?.score ?? 0;
		const bar = Math.max(FOLDER_FLOOR, best * FOLDER_RELATIVE);
		const keep = new Set(
			levelScores
				.filter((entry, rank) => entry.score >= bar || (rank < FOLDERS_ALWAYS_KEPT && entry.score >= FOLDER_MIN))
				.map(entry => entry.path),
		);
		// Jev judges folders from names alone and sometimes undersells the obvious one
		// ("notifications/" at 0.2 for a notification question). The folders whose own name
		// or file names share the most query words are entered too.
		const lexicalFolders = levelScores
			.filter(entry => !keep.has(entry.path))
			.map(entry => {
				const folder = folders.get(entry.path)!;
				const names = termHits(`${entry.path} ${folder.files.join(" ")}`, terms);
				return { entry, hits: lexical.size > 0 ? (folderLexical.get(entry.path) ?? 0) : names };
			})
			.filter(candidate => candidate.hits > 0)
			.sort((a, b) => b.hits - a.hits || b.entry.score - a.entry.score)
			.slice(0, LEXICAL_FOLDERS_KEPT);
		for (const { entry } of lexicalFolders) keep.add(entry.path);
		frontier = levelScores
			.filter(entry => keep.has(entry.path))
			.map(entry => {
				folderScore.set(entry.path, Math.max(entry.score, FOLDER_FLOOR));
				return entry.path;
			});
	}

	// The strongest local keyword matches are judged wherever they live: Jev prunes folders
	// from names alone, and a pruned folder would otherwise hide an exact match.
	for (const [file, score] of [...lexical].sort((a, b) => b[1] - a[1]).slice(0, LEXICAL_FILES_KEPT)) {
		if (score > 0) candidates.set(file, Math.max(candidates.get(file) ?? 0, 1 + score));
	}

	// --- File judgement: path + declaration lines, no bodies -------------------------
	// Most promising folders first, so a cap drops the least likely files, not the late alphabet.
	let fileList = [...candidates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([file]) => file);
	const totalCandidates = fileList.length;
	if (fileList.length > MAX_CANDIDATE_FILES) {
		fileList = fileList.slice(0, MAX_CANDIDATE_FILES);
		truncated = true;
	}
	const outlines = new Map<string, OutlineLine[]>();
	await inParallel(fileList, 16, async file => {
		outlines.set(file, await deps.outline(path.join(params.root, file), deps.signal).catch(() => []));
	});

	const scored: LocatedFile[] = [];
	const fileBatches = chunk(fileList, FILES_PER_REQUEST);
	const fileAnswers = await inParallel(fileBatches, CONCURRENCY, async batch => {
		const body = batch
			.map(file => {
				const text = fitOutline(outlines.get(file) ?? [], terms);
				return `### ${file}\n${text || "  (no declarations extracted)\n"}`;
			})
			.join("\n");
		const questions: Record<string, NoulQuestion> = {};
		batch.forEach((file, index) => {
			questions[`p${index}`] = {
				type: "noul",
				instructions: `Does "${file}" contain code that implements, directly handles, or tests what the question asks? Judge from its path and declarations.`,
			};
		});
		const scores = await ask(`Question: ${params.query}\n\nFiles (declarations only):\n${body}`, questions);
		return { batch, scores };
	});
	let filesJudged = 0;
	for (const { batch, scores } of fileAnswers) {
		if (!scores) continue;
		filesJudged += batch.length;
		batch.forEach((file, index) => {
			// Jev's judgement from declarations, nudged by the local keyword score (which can
			// see comments and strings). Clamped so the display stays a 0..1 score.
			const jev = scores.get(`p${index}`) ?? 0;
			const score = Math.min(1, jev + LEXICAL_WEIGHT * lex(file));
			scored.push({ path: file, score, outline: outlines.get(file) ?? [] });
		});
	}
	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	await rerank(scored, params.query, terms, outlines, request);
	// Rerank order wins; below the rerank head files are already in score order.
	const files = scored
		.filter(file => file.score >= WEAK_FILE_BAR)
		.slice(0, params.limit)
		.map(file => (file.score < FILE_BAR ? { ...file, weak: true } : file));
	return {
		files,
		weakLeads: files.length === 0 ? scored.slice(0, 3) : [],
		foldersJudged,
		filesJudged,
		requests,
		failedRequests,
		candidates: totalCandidates,
		truncated,
		durationMs: Date.now() - started,
	};
}

/** How many top files the final comparison looks at together. */
const RERANK_FILES = 6;

/**
 * Put the leading files in order with one comparative question. Each file was scored on
 * its own, and near-equal scores (0.62 vs 0.60) order close siblings almost at random;
 * shown side by side, the one that implements the behaviour is picked reliably. Jev
 * returns a probability per file for a choice question; files are reordered by it and keep
 * their own score for display. A failed request leaves the order as it was.
 */
async function rerank(
	scored: LocatedFile[],
	query: string,
	terms: readonly string[],
	outlines: Map<string, OutlineLine[]>,
	request: (
		state: string,
		questions: Record<string, ChoiceQuestion>,
		reserved: boolean,
	) => Promise<DecisionResult | null>,
): Promise<void> {
	const head = scored.slice(0, RERANK_FILES).filter(file => file.score >= WEAK_FILE_BAR);
	if (head.length < 2) return;
	const criteria: Record<string, string> = {};
	head.forEach((file, index) => {
		criteria[`c${index}`] = file.path;
	});
	const body = head
		.map((file, index) => `### c${index}: ${file.path}\n${fitOutline(outlines.get(file.path) ?? [], terms)}`)
		.join("\n");
	const result = await request(
		`Question: ${query}\n\nCandidate files (declarations only):\n${body}`,
		{
			best: {
				type: "choice",
				instructions:
					"Which file most directly implements, handles, or tests what the question asks? Judge from paths and declarations.",
				criteria,
			},
		},
		true,
	);
	const answer = result?.answers.best;
	if (answer?.type !== "choice") return;
	const probability = (index: number) =>
		answer.probabilities?.[`c${index}`] ?? (answer.choice === `c${index}` ? 1 : 0);
	const reordered = head
		.map((file, index) => ({ file, p: probability(index), index }))
		.sort((a, b) => b.p - a.p || a.index - b.index)
		.map(entry => entry.file);
	scored.splice(0, head.length, ...reordered);
}

/**
 * An outline within {@link OUTLINE_CHARS_PER_FILE}. When it does not fit, declarations
 * that share words with the query go first, so the one that matters in a large file is
 * not the one cut; the kept lines stay in source order.
 */
function fitOutline(outline: readonly OutlineLine[], terms: readonly string[]): string {
	const render = (entries: readonly OutlineLine[]) => entries.map(entry => `  ${entry.text}\n`).join("");
	const full = render(outline);
	if (full.length <= OUTLINE_CHARS_PER_FILE) return full;
	const ordered = outline
		.map((entry, index) => ({ entry, index, hits: termHits(entry.text, terms) }))
		.sort((a, b) => b.hits - a.hits || a.index - b.index);
	const kept: Array<{ entry: OutlineLine; index: number }> = [];
	let used = 4; // room for the ellipsis line
	for (const candidate of ordered) {
		const size = candidate.entry.text.length + 3;
		if (used + size > OUTLINE_CHARS_PER_FILE) continue;
		kept.push(candidate);
		used += size;
	}
	kept.sort((a, b) => a.index - b.index);
	return `${render(kept.map(candidate => candidate.entry))}  …\n`;
}

/**
 * Lines that are not declarations: blank, comments, lone brackets, imports, and union or
 * intersection members (`| "spawn_failed"`), which otherwise crowd real signatures out.
 */
const NOT_DECLARATION =
	/^\s*$|^\s*(\/\/|\/\*|\*|#(?!\[)|"""|'''|--)|^\s*[)\]};,]+\s*$|^\s*(import\b|from\s+\S+\s+import\b|use\s)|^\s*[|&]\s|^\s*['"`]|^\s*(return|assert|yield|raise|pass|del|await)\b/;
const MAX_OUTLINE_LINES = 60;
const MAX_OUTLINE_LINE_CHARS = 140;
/** A kept line that opens a type-like container whose body lists members, not statements. */
const CONTAINER_HEAD = /\b(class|interface|impl|trait|struct|enum|object|namespace|module|protocol|extension)\b/;
/** Member-level lines that are still control flow or noise, not declarations. */
const NOT_MEMBER = /^(return|if|else|for|while|switch|case|throw|await|yield|super|this\.|@)/;

/**
 * The declaration part of a line: an initialiser is cut (`const LIMIT = 42` → `const
 * LIMIT`, `secret = "x"` → `secret`) unless the value is a function, whose parameters are
 * the signature. Values are data, not names.
 */
/** A trailing ` # …` or ` // …` comment, when no string could be holding the marker. */
function withoutTrailingComment(text: string): string {
	const match = /\s+(#|\/\/)\s.*$/.exec(text);
	if (!match) return text;
	const before = text.slice(0, match.index);
	const balanced = [`"`, `'`, "`"].every(quote => (before.split(quote).length - 1) % 2 === 0);
	return balanced ? before : text;
}

function declarationOnly(text: string): string {
	const assign = /^([^=(]*?[^=!<>])\s*=\s*(?!=|>)(.*)$/.exec(text);
	if (!assign) return text;
	const value = assign[2]!.trim();
	if (/^(async\b|function\b|\(|<|[A-Za-z_$][\w$]*\s*=>)/.test(value)) return text;
	return assign[1]!.trim();
}

/**
 * Declaration lines from a structural summary whose bodies and comments were all elided
 * (`minBodyLines: 1`, `minCommentLines: 1`), plus the member lines of elided class-like
 * bodies taken from `sourceLines`: the summariser folds a whole class body, so its methods
 * would otherwise vanish. Only lines at the body's own member indentation are taken;
 * method bodies sit deeper and never come along. Initialisers are cut, so values do not
 * leave the machine. Over {@link MAX_OUTLINE_LINES}, top-level declarations and methods
 * are kept before fields, so a long run of type members never hides what follows.
 */
export function outlineFromSegments(
	segments: ReadonlyArray<{ kind: string; startLine: number; endLine?: number; text?: string | null }>,
	sourceLines: readonly string[] = [],
): OutlineLine[] {
	const all: Array<OutlineLine & { rank: number }> = [];
	const push = (line: number, raw: string, rank: number) => {
		const trimmed = declarationOnly(withoutTrailingComment(raw.trim()));
		all.push({
			line,
			rank,
			text: trimmed.length > MAX_OUTLINE_LINE_CHARS ? `${trimmed.slice(0, MAX_OUTLINE_LINE_CHARS)}…` : trimmed,
		});
	};
	// Lines inside block comments, docstrings and multi-line string literals. The per-line
	// filter only sees a comment's opening line; everything after it would leak.
	const masked = maskedLines(sourceLines.length > 0 ? sourceLines : linesFromSegments(segments));
	let lastHead = "";
	for (const segment of segments) {
		if (segment.kind === "elided") {
			if (CONTAINER_HEAD.test(lastHead) && segment.endLine !== undefined) {
				pushMembers(segment.startLine, segment.endLine, sourceLines, masked, push);
			}
			continue;
		}
		if (!segment.text) continue;
		const lines = segment.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const text = lines[i]!;
			if (masked.has(segment.startLine + i) || NOT_DECLARATION.test(text)) continue;
			lastHead = text;
			const topLevel = !/^\s/.test(text);
			// 0: top-level declaration, 1: nested callable (method), 2: nested field.
			push(segment.startLine + i, text, topLevel ? 0 : text.includes("(") ? 1 : 2);
		}
	}
	const kept =
		all.length <= MAX_OUTLINE_LINES
			? all
			: [...all]
					.sort((a, b) => a.rank - b.rank || a.line - b.line)
					.slice(0, MAX_OUTLINE_LINES)
					.sort((a, b) => a.line - b.line);
	return kept.map(({ line, text }) => ({ line, text }));
}

function linesFromSegments(
	segments: ReadonlyArray<{ kind: string; startLine: number; text?: string | null }>,
): string[] {
	const lines: string[] = [];
	for (const segment of segments) {
		if (segment.kind === "elided" || !segment.text) continue;
		segment.text.split("\n").forEach((text, i) => {
			lines[segment.startLine - 1 + i] = text;
		});
	}
	return Array.from(lines, text => text ?? "");
}

const TRIPLE_QUOTES = ['"""', "'''"] as const;

/**
 * 1-based numbers of lines that belong to a multi-line comment or string: `/* … *\/`
 * blocks (including `/**` and Rust's `/*!`), Python triple-quoted docstrings and strings,
 * and multi-line template literals. A declaration line that opens a string value
 * (`x = """`) is not masked itself — its initialiser is cut later — but the lines after
 * it are.
 */
export function maskedLines(lines: readonly string[]): Set<number> {
	const masked = new Set<number>();
	let closer: string | undefined;
	lines.forEach((text, index) => {
		const line = index + 1;
		const trimmed = text.trim();
		if (closer) {
			masked.add(line);
			if (text.includes(closer)) closer = undefined;
			return;
		}
		if (trimmed.startsWith("/*")) {
			masked.add(line);
			if (!trimmed.slice(2).includes("*/")) closer = "*/";
			return;
		}
		for (const quote of TRIPLE_QUOTES) {
			const count = text.split(quote).length - 1;
			if (count === 0) continue;
			if (/^[rbuRBUfF]{0,2}("""|''')/.test(trimmed)) masked.add(line);
			if (count % 2 === 1) closer = quote;
			return;
		}
		if ((text.split("`").length - 1) % 2 === 1) {
			closer = "`";
			return;
		}
		// Rust raw string `r#"…"#`: it ends only at `"` followed by the same number of `#`.
		const raw = /\br(#+)"/.exec(text);
		if (raw) {
			const end = `"${raw[1]}`;
			if (!text.slice(raw.index + raw[0].length).includes(end)) {
				closer = end;
				return;
			}
		}
		// An odd number of double quotes opens a string that continues on the next lines
		// (Rust and Go allow it; `r#"…"#` raw strings too). Char literals and escapes first.
		const quotes = text.replace(/\\./g, "").replace(/'"'/g, "").split('"').length - 1;
		if (quotes % 2 === 1) closer = '"';
	});
	return masked;
}

function pushMembers(
	startLine: number,
	endLine: number,
	sourceLines: readonly string[],
	masked: ReadonlySet<number>,
	push: (line: number, raw: string, rank: number) => void,
): void {
	let memberIndent: string | undefined;
	for (let line = startLine; line <= endLine && line <= sourceLines.length; line++) {
		const text = sourceLines[line - 1]!;
		if (masked.has(line) || NOT_DECLARATION.test(text)) continue;
		const indent = /^\s*/.exec(text)![0];
		memberIndent ??= indent;
		if (indent !== memberIndent) continue;
		const trimmed = text.trim();
		if (NOT_MEMBER.test(trimmed)) continue;
		push(line, text, trimmed.includes("(") ? 1 : 2);
	}
}

/** A top-level declaration line in TS/JS, Python, Rust or Go. */
const TOP_DECLARATION =
	/^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|var|namespace|def|struct|trait|impl|fn|pub|func)\b/;
/** A method or member signature one indent level in: `name(`, `async name(`, `#name(`, `get name(`. */
const MEMBER_DECLARATION =
	/^(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set|declare)\s+)*(?:#?[A-Za-z_$][\w$]*)\s*[<(]/;

/**
 * Fallback outline for a file the structural parser rejects (1-2% of TypeScript files,
 * often large central ones). Keeps top-level declarations and members one indent level
 * in, under the same rules as {@link outlineFromSegments}: no comments, imports, bodies,
 * or initialiser values.
 */
export function outlineFromSource(sourceLines: readonly string[]): OutlineLine[] {
	const segments: Array<{ kind: string; startLine: number; text: string }> = [];
	let memberIndent: string | undefined;
	let inBlockComment = false;
	sourceLines.forEach((text, index) => {
		const trimmed = text.trim();
		if (inBlockComment) {
			if (trimmed.includes("*/")) inBlockComment = false;
			return;
		}
		if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
			inBlockComment = true;
			return;
		}
		const indent = /^\s*/.exec(text)![0];
		if (indent === "") {
			memberIndent = undefined;
			if (TOP_DECLARATION.test(trimmed)) segments.push({ kind: "kept", startLine: index + 1, text });
			return;
		}
		memberIndent ??= indent;
		if (indent === memberIndent && MEMBER_DECLARATION.test(trimmed) && !NOT_MEMBER.test(trimmed)) {
			segments.push({ kind: "kept", startLine: index + 1, text });
		}
	});
	return outlineFromSegments(segments);
}
