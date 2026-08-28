import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@sayknow-cli/ai";
import { displaySafeEscapedArguments } from "../src/agent-loop";
import type { AgentTool } from "../src/types";

const tool = { displaySafeEscapedArgFields: ["questions.question", "questions.options.label"] } as unknown as AgentTool;

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function call(raw: string, arguments_: Record<string, unknown>): ToolCall {
	return {
		type: "toolCall",
		id: "ask-1",
		name: "ask",
		arguments: arguments_,
		escapedNonAsciiArguments: true,
		escapedNonAsciiArgumentsRaw: raw,
	} as ToolCall;
}

describe("display-safe escaped non-ASCII tool arguments", () => {
	it("accepts Korean and emoji only in declared ask display fields", () => {
		const raw = String.raw`{"questions":[{"id":"q","question":"\uc548\ub155 \ud83d\ude00","options":[{"label":"\uc608"}]}]}`;
		const arguments_ = JSON.parse(raw) as Record<string, unknown>;
		expect(displaySafeEscapedArguments(tool, call(raw, arguments_))).toBe(true);
	});

	it("rejects escaped descendants below declared display leaves", () => {
		const questionDescendant = String.raw`{"questions":[{"id":"q","question":{"id":"\uc548\ub155"},"options":[]}]}`;
		expect(displaySafeEscapedArguments(tool, call(questionDescendant, JSON.parse(questionDescendant)))).toBe(false);

		const labelDescendant = String.raw`{"questions":[{"id":"q","question":"safe","options":[{"label":{"id":"\uc548\ub155"}}]}]}`;
		expect(displaySafeEscapedArguments(tool, call(labelDescendant, JSON.parse(labelDescendant)))).toBe(false);
	});
	it("rejects escaped non-ASCII in structural fields", () => {
		const raw = String.raw`{"questions":[{"id":"\uc548\ub155","question":"safe","options":[{"label":"yes"}]}]}`;
		expect(displaySafeEscapedArguments(tool, call(raw, JSON.parse(raw)))).toBe(false);
	});

	it("rejects ASCII-landing escapes and mismatched provider evidence", () => {
		const asciiRaw = String.raw`{"questions":[{"id":"q","question":"\u0061","options":[]}]}`;
		expect(displaySafeEscapedArguments(tool, call(asciiRaw, JSON.parse(asciiRaw)))).toBe(false);
		const koreanRaw = String.raw`{"questions":[{"id":"q","question":"\uc548\ub155","options":[]}]}`;
		expect(
			displaySafeEscapedArguments(
				tool,
				call(koreanRaw, { questions: [{ id: "q", question: "다름", options: [] }] }),
			),
		).toBe(false);
	});
});
