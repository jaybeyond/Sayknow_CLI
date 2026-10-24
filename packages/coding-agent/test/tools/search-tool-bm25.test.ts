import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { buildDiscoverableToolSearchIndex, type DiscoverableTool } from "../../src/tool-discovery/tool-index";
import type { ToolSession } from "../../src/tools/index";
import { SearchToolBm25Tool } from "../../src/tools/search-tool-bm25";

type DiscoveryToolSession = ToolSession & {
	isToolDiscoveryEnabled: () => boolean;
	getDiscoverableTools: () => DiscoverableTool[];
	getDiscoverableToolSearchIndex: () => ReturnType<typeof buildDiscoverableToolSearchIndex>;
	getSelectedDiscoveredToolNames: () => string[];
	activateDiscoveredTools: (toolNames: string[]) => Promise<string[]>;
	getSelected: () => string[];
};

function createSession(tools: DiscoverableTool[]): DiscoveryToolSession {
	const selected: string[] = [];
	const index = buildDiscoverableToolSearchIndex(tools);
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.discoveryMode": "all" }),
		isToolDiscoveryEnabled: () => true,
		getDiscoverableTools: () => tools,
		getDiscoverableToolSearchIndex: () => index,
		getSelectedDiscoveredToolNames: () => [...selected],
		activateDiscoveredTools: async names => {
			for (const name of names) if (!selected.includes(name)) selected.push(name);
			return names;
		},
		getSelected: () => [...selected],
	};
}

function tool(name: string, summary: string): DiscoverableTool {
	return {
		name,
		label: name,
		description: summary,
		summary,
		source: name.startsWith("mcp__") ? "mcp" : "builtin",
		schemaKeys: [],
	};
}

describe("SearchToolBm25Tool", () => {
	const tools = [
		tool("mcp__github_create_issue", "Create a GitHub issue"),
		tool("mcp__github_list_pull_requests", "List GitHub pull requests"),
		tool("find", "Find files matching a glob"),
	];

	it("uses a static description independent of the discoverable catalog", () => {
		expect(new SearchToolBm25Tool(createSession(tools)).description).toBe(
			new SearchToolBm25Tool(createSession([])).description,
		);
	});

	it("searches, activates, and preserves ranked activation order", async () => {
		const session = createSession(tools);
		const result = await new SearchToolBm25Tool(session).execute("call", { query: "github", limit: 2 });
		expect(result.details?.activated_tools).toEqual(["mcp__github_create_issue", "mcp__github_list_pull_requests"]);
		expect(session.getSelected()).toEqual(["mcp__github_create_issue", "mcp__github_list_pull_requests"]);
	});

	it("reports matches that are already active instead of an empty result", async () => {
		const session = createSession(tools);
		const search = new SearchToolBm25Tool(session);
		await search.execute("first", { query: "github", limit: 2 });
		const repeat = await search.execute("second", { query: "github", limit: 2 });
		const content = JSON.parse((repeat.content[0] as { text: string }).text);

		expect(content.activated_tools).toEqual([]);
		expect(content.already_active_tools).toEqual(["mcp__github_create_issue", "mcp__github_list_pull_requests"]);
		const fresh = JSON.parse(
			((await search.execute("third", { query: "find" })).content[0] as { text: string }).text,
		);
		expect(fresh).not.toHaveProperty("already_active_tools");
	});

	it("lists active tools when the session index omits them and nothing new matches", async () => {
		const session = createSession(tools);
		await new SearchToolBm25Tool(session).execute("first", { query: "github", limit: 1 });
		const indexWithoutActive = buildDiscoverableToolSearchIndex(tools.slice(1));
		const live = Object.assign(session, { getDiscoverableToolSearchIndex: () => indexWithoutActive });
		const repeat = await new SearchToolBm25Tool(live).execute("second", { query: "create issue" });
		const content = JSON.parse((repeat.content[0] as { text: string }).text);

		expect(content.match_count).toBe(0);
		expect(content.already_active_tools).toEqual(["mcp__github_create_issue"]);
	});

	it("uses the generic cached index for discovery execution", async () => {
		const session = createSession(tools);
		const result = await new SearchToolBm25Tool(session).execute("call", { query: "find" });
		expect(result.details?.tools.map(match => match.name)).toEqual(["find"]);
	});
});
