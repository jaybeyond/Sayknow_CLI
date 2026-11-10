import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@sayknow-cli/ai";
import { prompt } from "@sayknow-cli/utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import { redactProviderRefusalExplanations } from "./utils";

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

/**
 * 저장된 요약을 템플릿에 넣기 전에 정리한다. `prompt.render`는 이스케이프하지 않고,
 * 요약에는 도구 출력·저장소 텍스트·받아온 페이지가 섞일 수 있다.
 *
 * 코드 문자는 보존한다. `<`, `>`, `&`, `"`를 엔티티로 바꾸면 `if a < b` 같은 코드가
 * 깨진 채로 모델에 들어간다. 대신 래퍼를 깨는 태그(<summary>, </summary>,
 * <untrusted-content>, </untrusted-content>)만 열기 꺾쇠 뒤에 폭 없는 공백을 넣어
 * 태그로 파싱되지 않게 한다. 개행과 탭은 그대로 두고, 그 밖 제어문자·양방향 문자·
 * 짝 없는 서로게이트는 그대로 걷어낸다.
 */
function escapeSummaryMarkup(value: string): string {
	const neutralized = value.replace(
		/<\s*\/?\s*(?:untrusted-content|summary)(?=[\s>])[^>]*>/gi,
		tag => `<\u200b${tag.slice(1)}`,
	);
	return neutralized.replace(
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/g,
		(char, offset) => {
			const code = char.charCodeAt(0);
			const next = value.charCodeAt(offset + 1);
			const prev = value.charCodeAt(offset - 1);
			if (
				(code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
				(code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff)
			) {
				return char;
			}
			if (char === "\n" || char === "\t") return char;
			return `\\u${code.toString(16).padStart(4, "0")}`;
		},
	);
}

function renderFencedSummary(template: string, summary: string): string {
	const framed = `<untrusted-content>\n${escapeSummaryMarkup(summary)}\n</untrusted-content>`;
	return prompt.render(template, { summary: framed });
}

export function renderBranchSummaryContext(summary: string): string {
	return renderFencedSummary(BRANCH_SUMMARY_TEMPLATE, redactProviderRefusalExplanations(summary));
}

// Summaries persisted before refusal redaction existed still carry the provider's
// explanation; redact at render time so stored sessions stop re-sending it.
export function renderCompactionSummaryContext(summary: string): string {
	return renderFencedSummary(COMPACTION_SUMMARY_TEMPLATE, redactProviderRefusalExplanations(summary));
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((message): Message | undefined => {
			if (isCoreCompactionMessage(message)) {
				switch (message.role) {
					case "custom":
					case "hookMessage": {
						const content =
							typeof message.content === "string"
								? [{ type: "text" as const, text: message.content }]
								: message.content;
						return {
							role: "user",
							content,
							attribution: message.attribution,
							timestamp: message.timestamp,
						};
					}
					case "branchSummary":
						return {
							role: "user",
							content: [
								{
									type: "text" as const,
									text: renderBranchSummaryContext(message.summary),
								},
							],
							attribution: "agent",
							timestamp: message.timestamp,
						};
					case "compactionSummary":
						return {
							role: "user",
							content: [
								{
									type: "text" as const,
									text: renderCompactionSummaryContext(message.summary),
								},
							],
							attribution: "agent",
							providerPayload: message.providerPayload,
							timestamp: message.timestamp,
						};
				}
			}

			switch (message.role) {
				case "user":
					return { ...message, attribution: message.attribution ?? "user" };
				case "developer":
					return { ...message, attribution: message.attribution ?? "agent" };
				case "assistant":
					return message as AssistantMessage;
				case "toolResult":
					return {
						...message,
						content: getPrunedToolResultContent(message as ToolResultMessage),
						attribution: message.attribution ?? "agent",
					};
				default:
					return undefined;
			}
		})
		.filter(message => message !== undefined);
}
export const convertToLlm = defaultConvertToLlm;
