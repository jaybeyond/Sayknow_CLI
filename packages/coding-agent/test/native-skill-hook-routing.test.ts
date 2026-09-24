import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	observeRouting,
	resetLearnedKeywordCache,
	setLearnedKeywordStorePath,
	summarizeLearnedKeywords,
} from "../src/decisions/keyword-learning";
import type { PromptTriage, PromptTriageRequest } from "../src/decisions/prompt-triage";
import { dispatchSkcNativeSkillHook } from "../src/hooks/native-skill-hook";
import { detectPrimarySkillKeyword } from "../src/hooks/skill-state";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "skc-hook-routing-"));
	setLearnedKeywordStorePath(join(dir, "learned.json"));
});

afterEach(() => {
	setLearnedKeywordStorePath(undefined);
	resetLearnedKeywordCache();
	rmSync(dir, { recursive: true, force: true });
});

const calibrated = { confidence: 0.95, calibrated: true } as const;

/** A scripted model stage that records what it was asked. */
function scriptedTriager(answer: PromptTriage | null) {
	const asked: PromptTriageRequest[] = [];
	return {
		asked,
		triager: async (request: PromptTriageRequest) => {
			asked.push(request);
			return answer;
		},
	};
}

function userPrompt(text: string): Record<string, unknown> {
	return { hook_event_name: "UserPromptSubmit", prompt: text, cwd: dir, session_id: "hook-routing" };
}

function additionalContext(result: Awaited<ReturnType<typeof dispatchSkcNativeSkillHook>>): string {
	const output = result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null;
	return output?.hookSpecificOutput?.additionalContext ?? "";
}

test("the hook spends one model call on a prompt the keyword tables missed, and learns from it", async () => {
	const text = "설계가 위험해 보여. 먼저 승인받을 문서부터 만들자";
	expect(detectPrimarySkillKeyword(text)).toBeNull();
	const { asked, triager } = scriptedTriager({
		workflow: "ralplan",
		uiSkill: "emil-design-eng",
		workflowConfidence: 0.97,
		calibrated: true,
	});

	const result = await dispatchSkcNativeSkillHook(userPrompt(text), { configPaths: [], triager });

	expect(asked).toHaveLength(1);
	expect(asked[0]).toMatchObject({ text, skipUiSkill: false });
	expect(asked[0]?.skipWorkflow).toBeFalsy();
	const context = additionalContext(result);
	expect(context).toContain('"semantic:ralplan" -> ralplan');
	expect(context).toContain("semantic match");
	expect(context).toContain("`emil-design-eng`");
	// The answer was mined into the store: the same phrasing again promotes it.
	expect((await summarizeLearnedKeywords()).candidates).toBeGreaterThan(0);
});

test("a keyword promoted in a CLI session fires under Codex without asking the model", async () => {
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });
	const before = await summarizeLearnedKeywords();
	const unseen = "계획서 좀 빨리 만들어 봐";
	expect(detectPrimarySkillKeyword(unseen)).toBeNull();
	const { asked, triager } = scriptedTriager({
		workflow: "team",
		uiSkill: null,
		workflowConfidence: 0.99,
		calibrated: true,
	});

	const result = await dispatchSkcNativeSkillHook(userPrompt(unseen), { configPaths: [], triager });

	expect(additionalContext(result)).toContain("-> ralplan");
	// The keyword answered the workflow question; only the UI question was left,
	// and a keyword answer is never re-observed, so the model cannot overturn it.
	expect(asked).toHaveLength(1);
	expect(asked[0]).toMatchObject({ skipWorkflow: true });
	expect(await summarizeLearnedKeywords()).toEqual(before);
});

test("a hand-written keyword with a UI pattern hit never opens the model stage", async () => {
	const { asked, triager } = scriptedTriager(null);
	const result = await dispatchSkcNativeSkillHook(
		userPrompt("consensus plan for the migration, then polish the dashboard UI"),
		{ configPaths: [], triager },
	);
	expect(additionalContext(result)).toContain("-> ralplan");
	expect(additionalContext(result)).toContain("SKC detected frontend UI/UX work");
	expect(asked).toHaveLength(0);
});

test("`decisions.enabled: false` in config.yml keeps the hook keyword-only", async () => {
	const configPath = join(dir, "config.yml");
	writeFileSync(configPath, "decisions:\n  enabled: false\n");
	const { asked, triager } = scriptedTriager({
		workflow: "ralplan",
		uiSkill: null,
		workflowConfidence: 0.99,
		calibrated: true,
	});

	const result = await dispatchSkcNativeSkillHook(userPrompt("설계가 위험해 보여. 먼저 승인받을 문서부터 만들자"), {
		configPaths: [configPath],
		triager,
	});

	expect(asked).toHaveLength(0);
	expect(additionalContext(result)).not.toContain("ralplan");
});

test("`decisions.keywordLearning: false` ignores the learned table and records nothing", async () => {
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });
	const before = (await summarizeLearnedKeywords()).candidates;
	const configPath = join(dir, "config.yml");
	writeFileSync(configPath, "decisions:\n  keywordLearning: false\n");
	const { asked, triager } = scriptedTriager({
		workflow: "team",
		uiSkill: null,
		workflowConfidence: 0.99,
		calibrated: true,
	});

	const result = await dispatchSkcNativeSkillHook(userPrompt("계획서 좀 빨리 만들어 봐"), {
		configPaths: [configPath],
		triager,
	});

	// Without the learned table the keyword misses, so the model answers instead.
	expect(asked).toHaveLength(1);
	expect(additionalContext(result)).toContain("-> team");
	expect((await summarizeLearnedKeywords()).candidates).toBe(before);
});

test("a model stage that throws leaves the hook exactly as it was before the stage existed", async () => {
	const triager = async (): Promise<PromptTriage | null> => {
		throw new Error("credential store locked");
	};
	const result = await dispatchSkcNativeSkillHook(userPrompt("이 테스트 왜 깨지는지 봐줘"), {
		configPaths: [],
		triager,
	});
	expect(result.hookEventName).toBe("UserPromptSubmit");
	expect(additionalContext(result)).not.toContain("workflow keyword");
});
