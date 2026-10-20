import type { AgentTool, AgentToolContext, AgentToolResult } from "@sayknow-cli/agent-core";
import { prompt, untilAborted } from "@sayknow-cli/utils";
import * as z from "zod/v4";
import gitlabDescription from "../prompts/tools/gitlab.md" with { type: "text" };
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const MR_URL_PATTERN = /https?:\/\/\S+\/-\/merge_requests\/(\d+)/;
const NO_PIPELINE_PATTERN = /No pipeline found/i;
const MR_STATES = ["opened", "merged", "closed", "all"] as const;
const DESCRIPTION_LIMIT = 4000;
const LIST_LIMIT_MAX = 50;

const gitlabSchema = z
	.object({
		op: z.enum(["mr_create", "mr_view", "mr_list", "ci_status"] as const).describe("gitlab operation"),
		repo: z.string().describe("OWNER/REPO, GROUP/NAMESPACE/REPO, or project URL").optional(),
		mr: z.string().describe("merge request iid, url, or source branch").optional(),
		title: z.string().describe("mr title").optional(),
		description: z.string().describe("mr description markdown").optional(),
		source: z.string().describe("mr source branch").optional(),
		target: z.string().describe("mr target branch").optional(),
		draft: z.boolean().describe("open mr as draft").optional(),
		fill: z.boolean().describe("fill title/description from commits (also pushes the branch)").optional(),
		push: z.boolean().describe("push the source branch before creating the mr").optional(),
		reviewer: z.array(z.string()).describe("reviewer usernames").optional(),
		assignee: z.array(z.string()).describe("assignee usernames").optional(),
		label: z.array(z.string()).describe("labels").optional(),
		removeSourceBranch: z.boolean().describe("delete source branch on merge").optional(),
		squash: z.boolean().describe("squash commits on merge").optional(),
		state: z.enum(MR_STATES).describe("mr_list state filter").optional(),
		branch: z.string().describe("ci_status branch").optional(),
		limit: z.number().describe("max results").optional(),
	})
	.strict();

type GitlabInput = z.infer<typeof gitlabSchema>;

export interface GlabUser {
	username?: string;
	name?: string;
}

export interface GlabPipeline {
	id?: number;
	status?: string;
	ref?: string;
	sha?: string;
	web_url?: string;
	created_at?: string;
	updated_at?: string;
	jobs?: GlabJob[];
}

export interface GlabJob {
	name?: string;
	stage?: string;
	status?: string;
	web_url?: string;
	failure_reason?: string;
	allow_failure?: boolean;
}

export interface GlabMergeRequest {
	iid?: number;
	title?: string;
	description?: string | null;
	state?: string;
	draft?: boolean;
	web_url?: string;
	source_branch?: string;
	target_branch?: string;
	author?: GlabUser | null;
	reviewers?: GlabUser[] | null;
	labels?: string[] | null;
	created_at?: string;
	updated_at?: string;
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	head_pipeline?: GlabPipeline | null;
}

export interface GitlabToolDetails {
	meta?: OutputMeta;
	op: GitlabInput["op"];
	url?: string;
	iid?: number;
	created?: boolean;
}

function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function cleanList(values: string[] | undefined): string[] {
	return (values ?? []).map(value => value.trim()).filter(value => value.length > 0);
}

function withRepo(args: string[], repo: string | undefined): string[] {
	if (repo) args.push("--repo", repo);
	return args;
}

function line(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

function formatUser(user: GlabUser | null | undefined): string | undefined {
	if (!user) return undefined;
	if (user.username) return `@${user.username}`;
	return clean(user.name);
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n\n[description truncated at ${limit} chars]` : text;
}

export function formatMergeRequest(mr: GlabMergeRequest, heading: string): string {
	const title = clean(mr.title) ?? "Untitled";
	const lines = [mr.iid !== undefined ? `# ${heading} !${mr.iid}: ${title}` : `# ${heading}: ${title}`, ""];
	line(lines, "URL", mr.web_url);
	line(lines, "State", mr.state);
	line(lines, "Draft", mr.draft);
	if (mr.source_branch || mr.target_branch)
		line(lines, "Branches", `${mr.source_branch ?? "?"} -> ${mr.target_branch ?? "?"}`);
	line(lines, "Author", formatUser(mr.author));
	const reviewers = (mr.reviewers ?? []).map(formatUser).filter((value): value is string => Boolean(value));
	if (reviewers.length > 0) line(lines, "Reviewers", reviewers.join(", "));
	if (mr.labels && mr.labels.length > 0) line(lines, "Labels", mr.labels.join(", "));
	line(lines, "Merge status", mr.detailed_merge_status);
	if (mr.has_conflicts) line(lines, "Conflicts", true);
	if (mr.head_pipeline?.status) {
		line(
			lines,
			"Pipeline",
			`${mr.head_pipeline.status}${mr.head_pipeline.web_url ? ` (${mr.head_pipeline.web_url})` : ""}`,
		);
	}
	line(lines, "Created", mr.created_at);
	line(lines, "Updated", mr.updated_at);
	const description = clean(mr.description ?? undefined);
	if (description) lines.push("", "## Description", "", truncate(description, DESCRIPTION_LIMIT));
	return lines.join("\n").trim();
}

export function formatPipeline(pipeline: GlabPipeline): string {
	const lines = [
		`# Pipeline${pipeline.id !== undefined ? ` #${pipeline.id}` : ""}: ${pipeline.status ?? "unknown"}`,
		"",
	];
	line(lines, "URL", pipeline.web_url);
	line(lines, "Ref", pipeline.ref);
	line(lines, "SHA", pipeline.sha?.slice(0, 12));
	line(lines, "Updated", pipeline.updated_at ?? pipeline.created_at);
	const jobs = pipeline.jobs ?? [];
	if (jobs.length > 0) {
		lines.push("", "## Jobs", "");
		for (const job of jobs) {
			const reason = job.failure_reason ? ` (${job.failure_reason})` : "";
			const allowed = job.allow_failure && job.status === "failed" ? " [allowed to fail]" : "";
			lines.push(
				`- [${job.status ?? "?"}] ${job.stage ? `${job.stage}/` : ""}${job.name ?? "?"}${reason}${allowed}`,
			);
		}
	}
	return lines.join("\n").trim();
}

function result(text: string, details: GitlabToolDetails): AgentToolResult<GitlabToolDetails> {
	const builder = toolResult<GitlabToolDetails>(details).text(text);
	if (details.url) builder.sourceUrl(details.url);
	return builder.done();
}

export class GitlabTool implements AgentTool<typeof gitlabSchema, GitlabToolDetails> {
	readonly name = "gitlab";
	readonly summary = "Create and inspect GitLab merge requests and pipelines";
	readonly loadMode = "discoverable";
	readonly label = "GitLab";
	readonly description = prompt.render(gitlabDescription);
	readonly parameters = gitlabSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GitlabTool | null {
		if (!git.gitlab.available()) return null;
		return new GitlabTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GitlabInput,
		signal?: AbortSignal,
		_onUpdate?: unknown,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GitlabToolDetails>> {
		return untilAborted(signal, async () => {
			switch (params.op) {
				case "mr_create":
					return this.#mrCreate(params, signal);
				case "mr_view":
					return this.#mrView(params, signal);
				case "mr_list":
					return this.#mrList(params, signal);
				case "ci_status":
					return this.#ciStatus(params, signal);
				default:
					throw new ToolError(`Unsupported gitlab op: ${String((params as { op: unknown }).op)}`);
			}
		});
	}

	async #mrCreate(params: GitlabInput, signal: AbortSignal | undefined): Promise<AgentToolResult<GitlabToolDetails>> {
		const cwd = this.session.cwd;
		const repo = clean(params.repo);
		const title = clean(params.title);
		const fill = params.fill ?? false;
		if (!fill && !title) throw new ToolError("title is required unless fill is true");
		if (fill && (title || params.description !== undefined)) {
			throw new ToolError("fill is mutually exclusive with title and description");
		}
		const target = clean(params.target);
		const source = clean(params.source) ?? (await git.branch.current(cwd, signal)) ?? undefined;
		if (!source) throw new ToolError("source branch is required when HEAD is detached");
		if (target && target === source) throw new ToolError(`source and target branch are both ${source}`);

		// An open MR for the same source (and target, when given) is returned instead of creating a duplicate.
		const listArgs = withRepo(["mr", "list", "--source-branch", source, "--output", "json", "--per-page", "5"], repo);
		if (target) listArgs.push("--target-branch", target);
		const existing = await git.gitlab.json<GlabMergeRequest[]>(cwd, listArgs, signal, {
			repoProvided: Boolean(repo),
		});
		const open = Array.isArray(existing) ? existing.find(mr => mr.state === "opened") : undefined;
		if (open) {
			return result(
				`${formatMergeRequest(open, "Existing Merge Request")}\n\nAn open merge request for ${source} already exists; nothing was created.`,
				{ op: "mr_create", url: open.web_url, iid: open.iid, created: false },
			);
		}

		const args = withRepo(["mr", "create", "--yes", "--source-branch", source], repo);
		if (target) args.push("--target-branch", target);
		if (fill) args.push("--fill");
		else {
			args.push("--title", title as string);
			// An explicit (possibly empty) description keeps glab from prompting for one.
			args.push("--description", params.description ?? "");
		}
		if (params.draft) args.push("--draft");
		if (params.push && !fill) args.push("--push");
		if (params.removeSourceBranch !== undefined) args.push(`--remove-source-branch=${params.removeSourceBranch}`);
		if (params.squash !== undefined) args.push(`--squash-before-merge=${params.squash}`);
		for (const reviewer of cleanList(params.reviewer)) args.push("--reviewer", reviewer);
		for (const assignee of cleanList(params.assignee)) args.push("--assignee", assignee);
		for (const label of cleanList(params.label)) args.push("--label", label);

		const output = await git.gitlab.text(cwd, args, signal, { repoProvided: Boolean(repo) });
		const match = git.cleanGlabMessage(output).match(MR_URL_PATTERN) ?? output.match(MR_URL_PATTERN);
		if (!match) {
			throw new ToolError(
				`glab mr create did not report a merge request URL: ${git.cleanGlabMessage(output) || "(no output)"}`,
			);
		}
		const url = match[0];
		const iid = Number(match[1]);
		let mr: GlabMergeRequest = {
			iid,
			web_url: url,
			title,
			source_branch: source,
			target_branch: target,
			draft: params.draft,
		};
		try {
			mr = await git.gitlab.json<GlabMergeRequest>(
				cwd,
				withRepo(["mr", "view", String(iid), "--output", "json"], repo),
				signal,
				{
					repoProvided: Boolean(repo),
				},
			);
		} catch {
			// Best-effort summary; the merge request already exists.
		}
		return result(formatMergeRequest(mr, "Created Merge Request"), { op: "mr_create", url, iid, created: true });
	}

	async #mrView(params: GitlabInput, signal: AbortSignal | undefined): Promise<AgentToolResult<GitlabToolDetails>> {
		const repo = clean(params.repo);
		const args = ["mr", "view"];
		const mr = clean(params.mr);
		if (mr) args.push(mr);
		args.push("--output", "json");
		const data = await git.gitlab.json<GlabMergeRequest>(this.session.cwd, withRepo(args, repo), signal, {
			repoProvided: Boolean(repo),
		});
		return result(formatMergeRequest(data, "Merge Request"), { op: "mr_view", url: data.web_url, iid: data.iid });
	}

	async #mrList(params: GitlabInput, signal: AbortSignal | undefined): Promise<AgentToolResult<GitlabToolDetails>> {
		const repo = clean(params.repo);
		const limit = Math.min(Math.max(Math.floor(params.limit ?? 10), 1), LIST_LIMIT_MAX);
		const args = withRepo(["mr", "list", "--output", "json", "--per-page", String(limit)], repo);
		const state = params.state ?? "opened";
		if (state === "merged") args.push("--merged");
		else if (state === "closed") args.push("--closed");
		else if (state === "all") args.push("--all");
		const source = clean(params.source);
		const target = clean(params.target);
		if (source) args.push("--source-branch", source);
		if (target) args.push("--target-branch", target);
		for (const label of cleanList(params.label)) args.push("--label", label);
		const items = await git.gitlab.json<GlabMergeRequest[]>(this.session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const list = Array.isArray(items) ? items : [];
		const lines = [`# GitLab merge requests (${state})`, "", `${list.length} result${list.length === 1 ? "" : "s"}`];
		for (const mr of list) {
			const draft = mr.draft ? " [draft]" : "";
			lines.push(
				`- !${mr.iid ?? "?"}${draft} ${clean(mr.title) ?? "Untitled"} — ${mr.source_branch ?? "?"} -> ${mr.target_branch ?? "?"}, ${formatUser(mr.author) ?? "unknown"}, ${mr.state ?? "?"}`,
			);
			if (mr.web_url) lines.push(`  ${mr.web_url}`);
		}
		return result(lines.join("\n"), { op: "mr_list" });
	}

	async #ciStatus(params: GitlabInput, signal: AbortSignal | undefined): Promise<AgentToolResult<GitlabToolDetails>> {
		const repo = clean(params.repo);
		const args = withRepo(["ci", "get", "--output", "json"], repo);
		const mr = clean(params.mr);
		const branch = clean(params.branch);
		if (mr) {
			if (!/^\d+$/.test(mr)) throw new ToolError("ci_status mr must be a merge request iid");
			args.push("--merge-request", mr);
		} else if (branch) args.push("--branch", branch);
		const run = await git.gitlab.run(this.session.cwd, args, signal);
		if (run.exitCode !== 0) {
			const message = git.cleanGlabMessage(run.stderr || run.stdout);
			if (NO_PIPELINE_PATTERN.test(message)) {
				return result(`# No pipeline\n\n${message}`, { op: "ci_status" });
			}
			throw new ToolError(git.formatGlabFailure(args, run.stdout, run.stderr, { repoProvided: Boolean(repo) }));
		}
		const pipeline = git.parseGlabJson<GlabPipeline>(run.stdout);
		return result(formatPipeline(pipeline), { op: "ci_status", url: pipeline.web_url });
	}
}
