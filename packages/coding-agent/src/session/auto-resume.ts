/**
 * Automatic, same-model resume of an interrupted model step.
 *
 * A step interrupted by a process restart, or by a transient failure after tools ran
 * or part of the answer was shown (managed fallback chains included), resumes at most once per user turn without a
 * new user message, pinned to the interrupted model. Calls whose outcome was never observed are answered with an error
 * placeholder and never re-run; while such calls exist the resumed turn may only
 * use built-in read-only tools.
 */
import type { AgentMessage, AgentTool } from "@sayknow-cli/agent-core";
import type { AssistantMessage, ToolCall } from "@sayknow-cli/ai";
import { unwrapProxiedTool } from "../extensibility/tool-proxy";
import { AstGrepTool } from "../tools/ast-grep";
import { FindTool } from "../tools/find";
import { LocateTool } from "../tools/locate";
import { ReadTool } from "../tools/read";
import { SearchTool } from "../tools/search";

export const AUTO_RESUME_MARKER_CUSTOM_TYPE = "auto_resume_marker";

/** Requests and time a restart resume may spend; the interrupted step's own budget is unknown. */
export const RESTART_RESUME_MAX_REQUESTS = 2;
export const RESTART_RESUME_WINDOW_MS = 120_000;

export const INTERRUPTED_TOOL_RESULT_TEXT =
	"Interrupted before its outcome was observed; it was not re-run. Check the current state with read-only tools before assuming it either happened or did not.";

export const AUTO_RESUME_RESTRICTED_PROMPT =
	"The previous step was interrupted and some tool calls have unknown outcomes; they were not re-run. Only read-only tools are available now. Verify the current state, then finish your answer or tell the user what still needs to be done. Do not repeat the interrupted actions.";

export const AUTO_RESUME_FULL_PROMPT =
	"The previous step was interrupted before it finished. Everything above is preserved exactly as the user saw it. Continue from where it stopped: do not repeat any of it and do not redo completed work.";

export type AutoResumeTrigger = "restart" | "interrupted";
export type AutoResumeMode = "full" | "restricted";

export type AutoResumePauseReason =
	| "disabled"
	| "already_resumed"
	| "uncertain_upstream"
	| "unsafe_tail"
	| "budget_exhausted"
	| "user_input_pending"
	| "selector_unavailable"
	| "no_restart_safe_tools"
	| "not_interrupted";

export type AutoResumeDecision =
	| { type: "pause"; reason: AutoResumePauseReason }
	| { type: "resume"; mode: AutoResumeMode; interruptedCalls: ToolCall[] };

export interface AutoResumeMarker {
	version: 1;
	trigger: AutoResumeTrigger;
	mode: AutoResumeMode;
	selector: string;
	interruptedCallIds: string[];
}

/** Built-in tools whose execution has no side effects and may run again after a restart. */
const RESTART_SAFE_TOOL_CLASSES = [ReadTool, SearchTool, FindTool, AstGrepTool, LocateTool] as const;

function wireName(tool: AgentTool): string {
	return tool.customWireName ?? tool.name;
}

/**
 * Restart-safe means: an instance of a built-in read-only tool class (seen through
 * extension/hook interception wrappers) whose wire name is unique among the selected
 * tools. Name-alikes from MCP, extensions or custom tools never qualify, and a
 * shadowed wire name disqualifies every holder.
 */
export function isRestartSafeTool(tool: AgentTool, selectedTools: readonly AgentTool[]): boolean {
	const root = unwrapProxiedTool(tool);
	if (!RESTART_SAFE_TOOL_CLASSES.some(toolClass => root instanceof toolClass)) return false;
	const name = wireName(tool);
	let holders = 0;
	for (const candidate of selectedTools) {
		if (candidate.name === name || wireName(candidate) === name) holders++;
	}
	return holders === 1;
}

/** Marks an in-memory pairing result the SDK adds on resume; it observed no outcome. */
export const SYNTHESIZED_ON_RESUME_DETAIL = "synthesizedOnResume";

/** A pairing result synthesized on resume: the call's real outcome is unknown. */
export function isSynthesizedResumeResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult") return false;
	const details = message.details as Record<string, unknown> | undefined;
	return details?.[SYNTHESIZED_ON_RESUME_DETAIL] === true;
}

/** Tool calls of the current user turn whose outcome no result in the transcript observed. */
export function findInterruptedToolCalls(messages: readonly AgentMessage[]): ToolCall[] {
	const start = messages.findLastIndex(message => message.role === "user") + 1;
	const answered = new Set<string>();
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "toolResult" && !isSynthesizedResumeResult(message)) answered.add(message.toolCallId);
	}
	const calls: ToolCall[] = [];
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && !answered.has(block.id)) calls.push(block);
		}
	}
	return calls;
}

/**
 * Tails that cannot be resumed safely: a failed step holding private signed reasoning
 * or tool calls (possibly cut off mid-arguments), a call without an id, or unanswered
 * calls whose results could no longer be placed directly after their assistant.
 */
function hasUnsafeAssistantTail(messages: readonly AgentMessage[]): boolean {
	const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
	// Only the current turn matters: an earlier turn's failure was already settled.
	if (assistantIndex === -1 || assistantIndex < messages.findLastIndex(message => message.role === "user"))
		return false;
	const assistant = messages[assistantIndex] as AssistantMessage;
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		if (
			assistant.content.some(
				block => block.type === "thinking" || block.type === "redactedThinking" || block.type === "toolCall",
			)
		)
			return true;
	}
	const interrupted = findInterruptedToolCalls(messages);
	if (interrupted.length === 0) return false;
	if (interrupted.some(call => call.id.trim().length === 0)) return true;
	const tailCallIds = new Set(assistant.content.flatMap(block => (block.type === "toolCall" ? [block.id] : [])));
	if (interrupted.some(call => !tailCallIds.has(call.id))) return true;
	return messages.slice(assistantIndex + 1).some(message => message.role !== "toolResult");
}

/** The trailing failed assistant shows a text prefix the user already saw. */
export function hasVisibleFailedPrefix(messages: readonly AgentMessage[]): boolean {
	const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
	if (assistantIndex === -1 || assistantIndex < messages.findLastIndex(message => message.role === "user"))
		return false;
	const assistant = messages[assistantIndex] as AssistantMessage;
	if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") return false;
	return assistant.content.some(block => block.type === "text" && block.text.length > 0);
}

export interface AutoResumePolicyInput {
	enabled: boolean;
	trigger: AutoResumeTrigger;
	/** Transcript the resume would be sent with. */
	messages: readonly AgentMessage[];
	/** An auto-resume marker exists after the last user message. */
	resumedThisTurn: boolean;
	/** Remote work with an unobservable outcome happened in the interrupted step. */
	uncertainUpstream: boolean;
	/** The provider transport executes work remotely (Cursor, pi-native). */
	opaqueTransport: boolean;
	/** The budget the resume would spend can still admit a request. */
	budgetAdmits: boolean;
	/** A user message, steer or follow-up is queued. */
	userInputPending: boolean;
	/** The interrupted step's selector still resolves to the current model. */
	selectorAvailable: boolean;
	/** The current serializer projects a failed plain-text prefix faithfully. */
	prefixReplayable: boolean;
	/** Currently selected tools. */
	selectedTools: readonly AgentTool[];
}

/** Single decision point for every automatic resume. */
export function resolveAutoResumePolicy(input: AutoResumePolicyInput): AutoResumeDecision {
	if (!input.enabled) return { type: "pause", reason: "disabled" };
	if (input.resumedThisTurn) return { type: "pause", reason: "already_resumed" };
	if (input.uncertainUpstream || input.opaqueTransport) return { type: "pause", reason: "uncertain_upstream" };
	if (input.userInputPending) return { type: "pause", reason: "user_input_pending" };
	if (!input.selectorAvailable) return { type: "pause", reason: "selector_unavailable" };
	if (!input.budgetAdmits) return { type: "pause", reason: "budget_exhausted" };
	if (hasUnsafeAssistantTail(input.messages)) return { type: "pause", reason: "unsafe_tail" };
	if (hasVisibleFailedPrefix(input.messages) && !input.prefixReplayable)
		return { type: "pause", reason: "unsafe_tail" };
	const tail = input.messages.at(-1);
	if (!tail) return { type: "pause", reason: "not_interrupted" };
	// Only a restart can find a user message whose request never settled.
	if (tail.role === "user") {
		return input.trigger === "restart"
			? { type: "resume", mode: "full", interruptedCalls: [] }
			: { type: "pause", reason: "not_interrupted" };
	}
	// An answer that already finished (its checkpoint write was simply lost) is not resumed.
	if (tail.role === "assistant" && tail.stopReason !== "error" && tail.stopReason !== "aborted") {
		const settled = !tail.content.some(block => block.type === "toolCall");
		if (settled) return { type: "pause", reason: "not_interrupted" };
	}
	const interruptedCalls = findInterruptedToolCalls(input.messages);
	if (interruptedCalls.length === 0) return { type: "resume", mode: "full", interruptedCalls };
	if (!input.selectedTools.some(tool => isRestartSafeTool(tool, input.selectedTools))) {
		return { type: "pause", reason: "no_restart_safe_tools" };
	}
	return { type: "resume", mode: "restricted", interruptedCalls };
}

/** Whether an auto-resume marker was written after the last user message of `entries`. */
export function hasAutoResumeMarkerSinceLastUser(
	entries: readonly { type: string; customType?: string; message?: { role: string } }[],
): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "user") return false;
		if (entry.type === "custom" && entry.customType === AUTO_RESUME_MARKER_CUSTOM_TYPE) return true;
	}
	return false;
}
