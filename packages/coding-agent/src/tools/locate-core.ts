import * as path from "node:path";
import type { DecisionRequest, DecisionResult, NoulQuestion } from "../decisions/types";

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
/** Priority of files sitting directly in the search root. */
const ROOT_FILE_PRIORITY = 0.5;
export const FILE_BAR = 0.5;
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
	const folders = buildTree(await deps.listFiles(params.root, deps.signal));
	let requests = 0;
	let failedRequests = 0;
	let foldersJudged = 0;
	let truncated = false;

	const ask = async (state: string, questions: Record<string, NoulQuestion>): Promise<Map<string, number> | null> => {
		if (deps.signal?.aborted) return null;
		if (requests >= MAX_REQUESTS) {
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
		if (!result) {
			failedRequests += 1;
			return null;
		}
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
	const addCandidate = (file: string, priority: number) => {
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
		frontier = levelScores
			.filter((entry, rank) => entry.score >= bar || (rank < FOLDERS_ALWAYS_KEPT && entry.score >= FOLDER_MIN))
			.map(entry => {
				folderScore.set(entry.path, entry.score);
				return entry.path;
			});
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
				let text = "";
				for (const entry of outlines.get(file) ?? []) {
					const next = `  ${entry.text}\n`;
					if (text.length + next.length > OUTLINE_CHARS_PER_FILE) {
						text += "  …\n";
						break;
					}
					text += next;
				}
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
			scored.push({ path: file, score: scores.get(`p${index}`) ?? 0, outline: outlines.get(file) ?? [] });
		});
	}
	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const files = scored.filter(file => file.score >= FILE_BAR).slice(0, params.limit);
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

/**
 * Lines that are not declarations: blank, comments, lone brackets, imports, and union or
 * intersection members (`| "spawn_failed"`), which otherwise crowd real signatures out.
 */
const NOT_DECLARATION =
	/^\s*$|^\s*(\/\/|\/\*|\*|#(?!\[)|"""|'''|--)|^\s*[)\]};,]+\s*$|^\s*(import\b|from\s+\S+\s+import\b|use\s)|^\s*[|&]\s/;
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
		const trimmed = declarationOnly(raw.trim());
		all.push({
			line,
			rank,
			text: trimmed.length > MAX_OUTLINE_LINE_CHARS ? `${trimmed.slice(0, MAX_OUTLINE_LINE_CHARS)}…` : trimmed,
		});
	};
	let lastHead = "";
	for (const segment of segments) {
		if (segment.kind === "elided") {
			if (CONTAINER_HEAD.test(lastHead) && segment.endLine !== undefined) {
				pushMembers(segment.startLine, segment.endLine, sourceLines, push);
			}
			continue;
		}
		if (!segment.text) continue;
		const lines = segment.text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const text = lines[i]!;
			if (NOT_DECLARATION.test(text)) continue;
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

function pushMembers(
	startLine: number,
	endLine: number,
	sourceLines: readonly string[],
	push: (line: number, raw: string, rank: number) => void,
): void {
	let memberIndent: string | undefined;
	for (let line = startLine; line <= endLine && line <= sourceLines.length; line++) {
		const text = sourceLines[line - 1]!;
		if (NOT_DECLARATION.test(text)) continue;
		const indent = /^\s*/.exec(text)![0];
		memberIndent ??= indent;
		if (indent !== memberIndent) continue;
		const trimmed = text.trim();
		if (NOT_MEMBER.test(trimmed)) continue;
		push(line, text, trimmed.includes("(") ? 1 : 2);
	}
}
