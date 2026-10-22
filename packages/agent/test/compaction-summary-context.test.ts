import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Context, Model } from "@sayknow-cli/ai";
import * as ai from "@sayknow-cli/ai";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
} from "../src/compaction/compaction";
import { renderBranchSummaryContext, renderCompactionSummaryContext } from "../src/compaction/messages";
import compactionSummaryPrompt from "../src/compaction/prompts/compaction-summary.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "../src/compaction/prompts/compaction-update-summary.md" with {
	type: "text",
};
import handoffDocumentPrompt from "../src/compaction/prompts/handoff-document.md" with { type: "text" };
import { createFileOps, redactProviderRefusalExplanations, serializeConversation } from "../src/compaction/utils";
import type { AgentMessage } from "../src/types";

// The compaction handoff must read as this session's work state, not as another model's
// reasoning being handed over: Anthropic's `reasoning_extraction` refusal classifier
// blocks long sessions whose context frames summaries that way.
const MODEL_HANDOFF_FRAMING = ["language model", "another llm", "another model", "other model", "instance of yourself"];

const REFUSAL =
	"Error: Refusal (reasoning_extraction): This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
const REDACTED = "Error: Refusal (reasoning_extraction): [provider explanation omitted]";

const MODEL: Model = {
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function requestText(ctx: Context): string {
	return ctx.messages
		.map(m => {
			const content = (m as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.filter((c): c is { type: "text"; text: string } => (c as { type?: string })?.type === "text")
				.map(c => c.text)
				.join("");
		})
		.join("");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("renderCompactionSummaryContext", () => {
	it("wraps the encoded summary as untrusted content and keeps the no-duplicate-work instruction", () => {
		const summary = "## Goal\n- Fix <tag> & keep {{braces}}";
		const rendered = renderCompactionSummaryContext(summary);

		expect(rendered).toContain(
			"<summary>\n<untrusted-content>\n## Goal\n- Fix &lt;tag&gt; &amp; keep {{braces}}\n</untrusted-content>\n</summary>",
		);
		expect(rendered).toContain("NEVER redo it");
	});

	it("does not frame the summary as another model's thinking or reasoning", () => {
		const rendered = renderCompactionSummaryContext("state").toLowerCase();

		for (const phrase of [...MODEL_HANDOFF_FRAMING, "thinking", "reasoning"]) {
			expect(rendered).not.toContain(phrase);
		}
	});

	it("redacts refusal explanations already persisted in stored summaries", () => {
		const stored = `## Critical Context\n- ${REFUSAL}\n- keep this line`;

		for (const rendered of [renderCompactionSummaryContext(stored), renderBranchSummaryContext(stored)]) {
			expect(rendered).toContain(REDACTED);
			expect(rendered).toContain("- keep this line");
			expect(rendered).not.toContain("reverse engineering");
		}
	});
});

describe("summarization prompts", () => {
	it("do not describe the summary as a handoff to another model", () => {
		for (const text of [compactionSummaryPrompt, compactionUpdateSummaryPrompt, handoffDocumentPrompt]) {
			const lower = text.toLowerCase();
			for (const phrase of MODEL_HANDOFF_FRAMING) {
				expect(lower).not.toContain(phrase);
			}
		}
	});
});

describe("redactProviderRefusalExplanations", () => {
	it("keeps the refusal category and drops the provider explanation", () => {
		expect(redactProviderRefusalExplanations(REFUSAL)).toBe(REDACTED);
	});

	it("stops at the end of the line, a backtick, or a double quote", () => {
		const text = [
			`- \`Refusal (cyber): blocked under policy\` was raised`,
			`- errorMessage "Refusal (safety): Policy violation" observed`,
			"Refusal (safety): first line\nsecond line stays",
		].join("\n");

		expect(redactProviderRefusalExplanations(text)).toBe(
			[
				"- `Refusal (cyber): [provider explanation omitted]` was raised",
				'- errorMessage "Refusal (safety): [provider explanation omitted]" observed',
				"Refusal (safety): [provider explanation omitted]\nsecond line stays",
			].join("\n"),
		);
	});

	it("is idempotent and leaves unrelated text untouched", () => {
		expect(redactProviderRefusalExplanations(REDACTED)).toBe(REDACTED);
		for (const text of ["Refusal (no details provided)", "Refusal: user declined the plan", "no refusal here"]) {
			expect(redactProviderRefusalExplanations(text)).toBe(text);
		}
	});

	it("applies to serialized conversations, previous summaries, and the stored summary", async () => {
		const serialized = serializeConversation([
			{ role: "user", content: REFUSAL, timestamp: 1 },
			assistant(`Saw ${REFUSAL}`),
		]);
		expect(serialized).not.toContain("reverse engineering");
		expect(serialized).toContain(REDACTED);

		const captured: Context[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, ctx) => {
			captured.push(ctx as Context);
			return assistant(`## Critical Context\n- ${REFUSAL}`);
		});
		const messages: AgentMessage[] = [{ role: "user", content: "continue", timestamp: 1 }];

		const summary = await generateSummary(messages, MODEL, 2_000, "key", undefined, undefined, `- ${REFUSAL}`);

		expect(captured).toHaveLength(1);
		const prompt = requestText(captured[0]);
		expect(prompt).toContain(`<previous-summary>\n- ${REDACTED}\n</previous-summary>`);
		expect(prompt).not.toContain("reverse engineering");
		// generateSummary returns raw model output; the compaction entry is redacted in compact().
		expect(summary).toContain("reverse engineering");
	});

	it("stores redacted summaries from compact(), whether generated or carried forward", async () => {
		const base: CompactionPreparation = {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "hello", timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 1_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
			tokenCorrection: { ratio: 1, keepRecentTokensCorrected: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens },
		};
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant(`## Critical Context\n- ${REFUSAL}`));

		const generated = await compact(base, MODEL, "key", undefined, undefined);
		const carried = await compact(
			{ ...base, messagesToSummarize: [], previousSummary: `- ${REFUSAL}` },
			MODEL,
			"key",
			undefined,
			undefined,
		);

		for (const result of [generated, carried]) {
			expect(result.summary).toContain(REDACTED);
			expect(result.summary).not.toContain("reverse engineering");
		}
	});
});
