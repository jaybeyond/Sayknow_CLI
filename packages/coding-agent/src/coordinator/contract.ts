export const COORDINATOR_MCP_PROTOCOL_VERSION = "2024-11-05";
export const COORDINATOR_MCP_SERVER_NAME = "skc-coordinator-mcp";

export const COORDINATOR_MCP_TOOL_NAMES = [
	"skc_coordinator_list_sessions",
	"skc_coordinator_read_status",
	"skc_coordinator_read_tail",
	"skc_coordinator_list_questions",
	"skc_coordinator_list_artifacts",
	"skc_coordinator_read_artifact",
	"skc_coordinator_read_coordination_status",
	"skc_coordinator_watch_events",
	"skc_coordinator_register_session",
	"skc_coordinator_start_session",
	"skc_coordinator_send_prompt",
	"skc_coordinator_submit_question_answer",
	"skc_coordinator_read_turn",
	"skc_coordinator_await_turn",
	"skc_coordinator_report_status",
	"skc_delegate_plan",
	"skc_delegate_execute",
	"skc_delegate_team",
] as const;

export type CoordinatorToolName = (typeof COORDINATOR_MCP_TOOL_NAMES)[number];
