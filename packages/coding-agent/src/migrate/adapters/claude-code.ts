/**
 * Claude Code adapter: reads `~/.claude.json` (mcpServers) and `~/.claude/skills`.
 */
import * as path from "node:path";
import type { AdapterResult, McpCandidate } from "../types";
import { type Adapter, type AdapterOptions, collectSkillDir, parseSourceJson, readSourceText } from "./index";

const SOURCE = "claude-code" as const;

export const claudeCodeAdapter: Adapter = {
	source: SOURCE,
	async collect({ homeDir }: AdapterOptions): Promise<AdapterResult> {
		const result: AdapterResult = { mcpCandidates: [], skillCandidates: [], diagnostics: [] };

		const configPath = path.join(homeDir, ".claude.json");
		const read = await readSourceText(configPath, SOURCE, "mcp");
		if ("diagnostic" in read) {
			result.diagnostics.push(read.diagnostic);
		} else {
			const parsed = parseSourceJson(read.text, configPath, SOURCE, "mcp");
			if ("diagnostic" in parsed) {
				result.diagnostics.push(parsed.diagnostic);
			} else {
				const servers = parsed.data.mcpServers;
				if (servers && typeof servers === "object" && !Array.isArray(servers)) {
					for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
						result.mcpCandidates.push({ source: SOURCE, name, raw } satisfies McpCandidate);
					}
				}
			}
		}

		const skills = await collectSkillDir(path.join(homeDir, ".claude", "skills"), SOURCE);
		result.skillCandidates.push(...skills.candidates);
		result.diagnostics.push(...skills.diagnostics);

		return result;
	},
};
