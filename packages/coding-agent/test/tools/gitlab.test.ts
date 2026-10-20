import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import { GitlabTool } from "@sayknow-cli/coding-agent/tools/gitlab";
import * as git from "@sayknow-cli/coding-agent/utils/git";

function createSession(cwd = "/tmp/test"): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "gitlab.enabled": true }),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

const CREATED = {
	iid: 43,
	title: "Add gizmo",
	description: "Adds a gizmo.",
	state: "opened",
	draft: true,
	web_url: "https://gitlab.example.com/group/proj/-/merge_requests/43",
	source_branch: "feature/gizmo",
	target_branch: "main",
	author: { username: "jieyi", name: "Jie Yi" },
	reviewers: [{ username: "rev1" }],
	labels: ["enhancement"],
	detailed_merge_status: "mergeable",
	has_conflicts: false,
	head_pipeline: null,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("gitlab tool", () => {
	it("mr_create builds a non-interactive glab argv and summarizes the created MR", async () => {
		const textCalls: string[][] = [];
		const jsonCalls: string[][] = [];
		vi.spyOn(git.gitlab, "json").mockImplementation(async <T>(_cwd: string, args: string[]): Promise<T> => {
			jsonCalls.push([...args]);
			if (args[1] === "list") return [] as T;
			return CREATED as T;
		});
		vi.spyOn(git.gitlab, "text").mockImplementation(async (_cwd, args) => {
			textCalls.push([...args]);
			return "\nCreating merge request for feature/gizmo into main in group/proj\n\n!43 Add gizmo (feature/gizmo)\n https://gitlab.example.com/group/proj/-/merge_requests/43\n";
		});
		const tool = new GitlabTool(createSession());
		const result = await tool.execute("c", {
			op: "mr_create",
			repo: "group/proj",
			title: "Add gizmo",
			description: "Adds a gizmo.",
			source: "feature/gizmo",
			target: "main",
			draft: true,
			push: true,
			reviewer: ["rev1", " "],
			label: ["enhancement"],
			removeSourceBranch: true,
		});

		expect(jsonCalls[0]).toEqual([
			"mr",
			"list",
			"--source-branch",
			"feature/gizmo",
			"--output",
			"json",
			"--per-page",
			"5",
			"--repo",
			"group/proj",
			"--target-branch",
			"main",
		]);
		expect(textCalls).toHaveLength(1);
		const args = textCalls[0];
		expect(args.slice(0, 3)).toEqual(["mr", "create", "--yes"]);
		for (const pair of [
			["--repo", "group/proj"],
			["--source-branch", "feature/gizmo"],
			["--target-branch", "main"],
			["--title", "Add gizmo"],
			["--description", "Adds a gizmo."],
			["--reviewer", "rev1"],
			["--label", "enhancement"],
		]) {
			expect(args).toEqual(expect.arrayContaining(pair));
		}
		expect(args).toContain("--draft");
		expect(args).toContain("--push");
		expect(args).toContain("--remove-source-branch=true");
		expect(args.filter(arg => arg === "--reviewer")).toHaveLength(1);
		expect(jsonCalls[1]).toEqual(["mr", "view", "43", "--output", "json", "--repo", "group/proj"]);

		const text = textOf(result);
		expect(text).toContain("# Created Merge Request !43: Add gizmo");
		expect(text).toContain("Branches: feature/gizmo -> main");
		expect(text).toContain("Reviewers: @rev1");
		expect(result.details).toMatchObject({ op: "mr_create", url: CREATED.web_url, iid: 43, created: true });
	});

	it("mr_create passes an empty description so glab never prompts, and defaults source to the current branch", async () => {
		vi.spyOn(git.branch, "current").mockResolvedValue("feature/current");
		vi.spyOn(git.gitlab, "json").mockImplementation(async <T>(_cwd: string, args: string[]): Promise<T> => {
			if (args[1] === "list") return [] as T;
			throw new Error("view unavailable");
		});
		const text = vi.spyOn(git.gitlab, "text").mockResolvedValue("https://gitlab.example.com/g/p/-/merge_requests/7");
		const tool = new GitlabTool(createSession());
		const result = await tool.execute("c", { op: "mr_create", title: "T" });
		const args = text.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--source-branch", "feature/current"]));
		expect(args).toEqual(expect.arrayContaining(["--description", ""]));
		expect(args).not.toContain("--repo");
		expect(args).not.toContain("--target-branch");
		// summary falls back to the parsed URL when the follow-up view fails
		expect(textOf(result)).toContain("# Created Merge Request !7: T");
		expect(result.details?.created).toBe(true);
	});

	it("mr_create returns an existing open MR instead of creating a duplicate", async () => {
		vi.spyOn(git.gitlab, "json").mockResolvedValue([
			{ ...CREATED, iid: 9, state: "merged" },
			{ ...CREATED, iid: 12 },
		]);
		const text = vi.spyOn(git.gitlab, "text");
		const tool = new GitlabTool(createSession());
		const result = await tool.execute("c", { op: "mr_create", title: "Add gizmo", source: "feature/gizmo" });
		expect(text).not.toHaveBeenCalled();
		expect(textOf(result)).toContain("# Existing Merge Request !12");
		expect(textOf(result)).toContain("nothing was created");
		expect(result.details).toMatchObject({ iid: 12, created: false });
	});

	it("mr_create with fill sends --fill without title/description and rejects mixed input", async () => {
		vi.spyOn(git.gitlab, "json").mockImplementation(
			async <T>(_cwd: string, args: string[]): Promise<T> => (args[1] === "list" ? [] : CREATED) as T,
		);
		const text = vi.spyOn(git.gitlab, "text").mockResolvedValue(CREATED.web_url);
		const tool = new GitlabTool(createSession());
		await tool.execute("c", { op: "mr_create", fill: true, source: "feature/gizmo", push: true });
		const args = text.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--fill");
		expect(args).not.toContain("--title");
		expect(args).not.toContain("--description");
		expect(args).not.toContain("--push"); // --fill already pushes

		await expect(tool.execute("c", { op: "mr_create", fill: true, title: "x", source: "a" })).rejects.toThrow(
			"fill is mutually exclusive",
		);
		await expect(tool.execute("c", { op: "mr_create", source: "a" })).rejects.toThrow("title is required");
		await expect(tool.execute("c", { op: "mr_create", title: "x", source: "main", target: "main" })).rejects.toThrow(
			"source and target branch are both main",
		);
	});

	it("mr_create fails loudly when glab reports no merge request URL", async () => {
		vi.spyOn(git.gitlab, "json").mockResolvedValue([]);
		vi.spyOn(git.gitlab, "text").mockResolvedValue("something unexpected");
		const tool = new GitlabTool(createSession());
		await expect(tool.execute("c", { op: "mr_create", title: "x", source: "a" })).rejects.toThrow(
			"did not report a merge request URL",
		);
	});

	it("mr_list maps state filters and renders entries", async () => {
		const json = vi.spyOn(git.gitlab, "json").mockResolvedValue([CREATED]);
		const tool = new GitlabTool(createSession());
		const result = await tool.execute("l", { op: "mr_list", state: "merged", target: "main", limit: 500 });
		const args = json.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--per-page", "50", "--merged", "--target-branch", "main"]));
		expect(textOf(result)).toContain("- !43 [draft] Add gizmo — feature/gizmo -> main, @jieyi, opened");
	});

	it("ci_status reports a missing pipeline instead of failing and renders jobs otherwise", async () => {
		const run = vi.spyOn(git.gitlab, "run").mockResolvedValueOnce({
			exitCode: 1,
			stdout: "",
			stderr: "\u001b[31m   ERROR  \u001b[0m\n\n  No pipeline found. It might not exist yet.\n",
		});
		const tool = new GitlabTool(createSession());
		const none = await tool.execute("s", { op: "ci_status", branch: "dev" });
		expect(run.mock.calls[0]?.[1]).toEqual(["ci", "get", "--output", "json", "--branch", "dev"]);
		expect(textOf(none)).toContain("# No pipeline");
		expect(textOf(none)).toContain("No pipeline found. It might not exist yet.");

		run.mockResolvedValueOnce({
			exitCode: 0,
			stdout: JSON.stringify({
				id: 501,
				status: "failed",
				ref: "dev",
				sha: "0123456789abcdef",
				web_url: "https://gitlab.example.com/g/p/-/pipelines/501",
				jobs: [
					{ name: "lint", stage: "test", status: "success" },
					{ name: "unit", stage: "test", status: "failed", failure_reason: "script_failure" },
				],
			}),
			stderr: "",
		});
		const ok = await tool.execute("s", { op: "ci_status", mr: "43" });
		expect(run.mock.calls[1]?.[1]).toEqual(["ci", "get", "--output", "json", "--merge-request", "43"]);
		expect(textOf(ok)).toContain("# Pipeline #501: failed");
		expect(textOf(ok)).toContain("- [failed] test/unit (script_failure)");

		run.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "401 Unauthorized" });
		await expect(tool.execute("s", { op: "ci_status" })).rejects.toThrow("glab auth login");
		await expect(tool.execute("s", { op: "ci_status", mr: "feature" })).rejects.toThrow(
			"must be a merge request iid",
		);
	});

	it("parseGlabJson skips notices glab prints on stdout before the payload", () => {
		// observed with glab 1.99: a NO_PROMPT deprecation notice precedes the JSON on stdout
		expect(
			git.parseGlabJson<{ iid: number }>(
				'DEPRECATION WARNING: The environment variable NO_PROMPT has been deprecated.\n{"iid":42}',
			),
		).toEqual({ iid: 42 });
		expect(git.parseGlabJson<number[]>("[1,2]")).toEqual([1, 2]);
		expect(() => git.parseGlabJson("no json here")).toThrow("invalid JSON");
		expect(() => git.parseGlabJson("")).toThrow("empty output");
		expect(() => git.parseGlabJson("{broken")).toThrow("invalid JSON");
	});

	it("cleanGlabMessage strips ANSI banners and update notices", () => {
		expect(
			git.cleanGlabMessage(
				"\u001b[1m   ERROR  \u001b[0m\n\n  X could not authenticate.\nA new version of glab has been released: v1 -> v2\nhttps://gitlab.com/gitlab-org/cli/-/releases/v2\n",
			),
		).toBe("could not authenticate.");
	});
});
