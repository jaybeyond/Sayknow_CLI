/**
 * Back-compat re-export layer.
 * All types and functions have moved to src/tool-discovery/tool-index.ts.
 * This file exists solely so existing imports continue to compile without changes.
 *
 * Upstream v0.11.x renamed `DiscoverableMCP*` → `DiscoverableTool*`; we re-export
 * the new symbols under the legacy names so existing call sites still compile.
 */
export type {
	DiscoverableToolSearchDocument as DiscoverableMCPSearchDocument,
	DiscoverableToolSearchIndex as DiscoverableMCPSearchIndex,
	DiscoverableToolSearchResult as DiscoverableMCPSearchResult,
	DiscoverableTool as DiscoverableMCPTool,
	DiscoverableToolServerSummary as DiscoverableMCPToolServerSummary,
	DiscoverableToolSummary as DiscoverableMCPToolSummary,
} from "../tool-discovery/tool-index";

export {
	buildDiscoverableToolSearchIndex as buildDiscoverableMCPSearchIndex,
	collectDiscoverableTools as collectDiscoverableMCPTools,
	formatDiscoverableToolServerSummary as formatDiscoverableMCPToolServerSummary,
	getDiscoverableTool as getDiscoverableMCPTool,
	isMCPBridgeTool,
	isMCPToolName,
	searchDiscoverableTools as searchDiscoverableMCPTools,
	selectDiscoverableToolNamesByServer as selectDiscoverableMCPToolNamesByServer,
	summarizeDiscoverableTools as summarizeDiscoverableMCPTools,
} from "../tool-discovery/tool-index";
