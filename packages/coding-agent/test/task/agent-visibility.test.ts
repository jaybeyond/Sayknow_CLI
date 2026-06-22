import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { TaskTool } from "../../src/task";
import { loadBundledAgents } from "../../src/task/agents";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition, TaskParams } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

function createSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("task agent visibility", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ships exactly the four canonical role agents, all visible", () => {
		const agents = loadBundledAgents();
		const names = agents.map(agent => agent.name).sort();
		expect(names).toEqual(["architect", "critic", "executor", "planner"]);
		for (const agent of agents) {
			expect(agent.hide).toBeUndefined();
		}
	});

	it("omits hidden agents from task tool descriptions and unknown-agent hints", async () => {
		const visible: AgentDefinition = {
			name: "public_agent",
			description: "Public agent",
			systemPrompt: "public",
			source: "bundled",
		};
		const hidden: AgentDefinition = {
			name: "support_agent",
			description: "Support agent",
			systemPrompt: "support",
			source: "bundled",
			hide: true,
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [visible, hidden],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		expect(tool.description).toContain("public_agent");
		expect(tool.description).not.toContain("support_agent");

		const unknownResult = await tool.execute("tool-call", {
			agent: "missing_agent",
			tasks: [{ id: "One", description: "one", assignment: "Do it." }],
		} as TaskParams);
		const unknownText = getFirstText(unknownResult);
		expect(unknownText).toContain("Available: public_agent");
		expect(unknownText).not.toContain("support_agent");
	});

	it("keeps hidden agents resolvable for direct task invocations", async () => {
		const hidden: AgentDefinition = {
			name: "support_agent",
			description: "Support agent",
			systemPrompt: "support",
			source: "bundled",
			hide: true,
		};
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [hidden],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", { agent: "support_agent", tasks: [] } as TaskParams);
		expect(getFirstText(result)).toContain("No tasks provided");
	});
});
