import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@sayknow-cli/agent-core";
import * as natives from "@sayknow-cli/natives";
import { prompt, untilAborted } from "@sayknow-cli/utils";
import * as z from "zod/v4";
import { createTypeSafeDecisionBackend, TYPESAFE_PROVIDER } from "../decisions/typesafe-backend";
import locateDescription from "../prompts/tools/locate.md" with { type: "text" };
import type { ToolSession } from ".";
import { FILE_BAR, type LocateResult, locateCode, type OutlineLine, outlineFromSegments } from "./locate-core";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const locateSchema = z.object({
	query: z.string().min(3).describe("What the code does, as a question or description"),
	path: z.string().optional().describe("Directory to search (default: working directory)"),
	limit: z.number().int().min(1).max(40).optional().describe("Most files to return (default 12)"),
});

type LocateParams = z.infer<typeof locateSchema>;

export interface LocateToolDetails {
	result: Omit<LocateResult, "files" | "weakLeads"> & { files: string[] };
}

/** Never uploaded: dependency, lock, build and binary files add cost without signal. */
const SKIPPED_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".icns",
	".svg",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".xz",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".mp3",
	".mp4",
	".mov",
	".wav",
	".wasm",
	".node",
	".dylib",
	".so",
	".dll",
	".exe",
	".bin",
	".dmg",
	".db",
	".sqlite",
	".map",
	".lock",
	".snap",
	".pile",
]);
const SKIPPED_NAMES = new Set([
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
]);
const MAX_LISTED_FILES = 20_000;
const MAX_OUTLINE_BYTES = 512 * 1024;

export class LocateTool implements AgentTool<typeof locateSchema, LocateToolDetails> {
	readonly name = "locate";
	readonly label = "Locate";
	readonly summary = "Find code by describing what it does (Jev relevance judgement)";
	readonly description: string;
	readonly parameters = locateSchema;
	readonly strict = true;

	/**
	 * Offered only when it can work: a TypeSafe key is stored and `locate.enabled` is on.
	 * Without the hosted model every judgement would fall to an uncalibrated LLM, one
	 * request per folder batch, which costs more than the search saves.
	 */
	static createIf(session: ToolSession): LocateTool | null {
		if (!session.settings.get("locate.enabled")) return null;
		if (!session.modelRegistry?.authStorage.hasAuth(TYPESAFE_PROVIDER)) return null;
		return new LocateTool(session);
	}

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(locateDescription);
	}

	async execute(
		_toolCallId: string,
		params: LocateParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<LocateToolDetails>> {
		return untilAborted(signal, async () => {
			const registry = this.session.modelRegistry;
			if (!registry) throw new ToolError("locate needs a model registry");
			const root = resolveToCwd(params.path ?? ".", this.session.cwd);
			if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
				throw new ToolError(`Not a directory: ${params.path ?? root}`);
			}
			if (root === path.parse(root).root) throw new ToolError("Searching from the filesystem root is not allowed");

			const backend = createTypeSafeDecisionBackend({
				registry,
				sessionId: this.session.getSessionId?.() ?? undefined,
			});
			const result = await locateCode(
				{ query: params.query, root, limit: params.limit ?? 12 },
				{ listFiles, outline, decide: request => backend.decide(request), signal },
			);
			if (result.requests > 0 && result.failedRequests === result.requests) {
				throw new ToolError(
					"Jev did not answer (TypeSafe key missing, rejected, or unreachable). Use search/find, or re-add the key with /provider typesafe.",
				);
			}
			return {
				content: [{ type: "text", text: formatLocateResult(params.query, root, this.session.cwd, result) }],
				details: { result: { ...result, files: result.files.map(file => file.path) } },
			};
		});
	}
}

async function listFiles(root: string, signal?: AbortSignal): Promise<string[]> {
	const { matches } = await natives.glob({
		pattern: "**/*",
		path: root,
		fileType: natives.FileType.File,
		hidden: false,
		gitignore: true,
		maxResults: MAX_LISTED_FILES,
		signal,
	});
	return matches
		.map(match => match.path.split(path.sep).join("/"))
		.filter(file => {
			const base = path.posix.basename(file);
			return !SKIPPED_NAMES.has(base) && !SKIPPED_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
		});
}

async function outline(absolutePath: string): Promise<OutlineLine[]> {
	const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.size > MAX_OUTLINE_BYTES) return [];
	const code = await Bun.file(absolutePath).text();
	// minBodyLines/minCommentLines 1: every body and comment is elided, signatures remain.
	const summary = natives.summarizeCode({ code, path: absolutePath, minBodyLines: 1, minCommentLines: 1 });
	return summary.parsed ? outlineFromSegments(summary.segments, code.split("\n")) : [];
}

export function formatLocateResult(query: string, root: string, cwd: string, result: LocateResult): string {
	const where = path.relative(cwd, root) || ".";
	const lines = [
		`locate "${query}" in ${where}`,
		`${result.files.length} relevant file(s); judged ${result.foldersJudged} folders and ${result.filesJudged} of ${result.candidates} candidate files in ${result.requests} Jev requests, ${(result.durationMs / 1000).toFixed(1)}s. Sent: paths and declaration lines only.`,
	];
	if (result.failedRequests > 0) lines.push(`${result.failedRequests} request(s) failed; results may be incomplete.`);
	if (result.truncated) lines.push("Search budget reached; narrow `path` for a complete pass.");
	const show = (files: LocateResult["files"]) => {
		files.forEach((file, index) => {
			const shown = path.relative(cwd, path.join(root, file.path));
			lines.push("", `${index + 1}. ${shown}  (${file.score.toFixed(2)})`);
			for (const entry of file.outline.slice(0, 12)) lines.push(`   L${entry.line} ${entry.text}`);
			if (file.outline.length > 12) lines.push(`   … ${file.outline.length - 12} more declarations`);
		});
	};
	if (result.files.length > 0) show(result.files);
	else if (result.weakLeads.length > 0) {
		lines.push("", `No file cleared the relevance bar (${FILE_BAR}). Weak leads:`);
		show(result.weakLeads);
	} else lines.push("", "No candidates. Try a broader path or search/find.");
	return lines.join("\n");
}
