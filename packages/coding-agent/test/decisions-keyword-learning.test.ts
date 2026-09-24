import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionService } from "../src/decisions";
import {
	loadLearnedKeywordDefinitions,
	mineShingles,
	observeRouting,
	resetLearnedKeywordCache,
	setLearnedKeywordStorePath,
	summarizeLearnedKeywords,
} from "../src/decisions/keyword-learning";
import { buildUiSkillCriteria, createPromptTriage } from "../src/decisions/prompt-triage";
import type { DecisionBackend, DecisionResult } from "../src/decisions/types";
import { MAX_OPTIONS } from "../src/decisions/types";
import { detectPrimarySkillKeyword } from "../src/hooks/skill-state";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "skc-learned-keywords-"));
	setLearnedKeywordStorePath(join(dir, "learned.json"));
});

afterEach(() => {
	setLearnedKeywordStorePath(undefined);
	resetLearnedKeywordCache();
	rmSync(dir, { recursive: true, force: true });
});

const calibrated = { confidence: 0.95, calibrated: true } as const;

test("a pattern promotes only after two distinct prompts agree", async () => {
	const first = await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	expect(first.promoted).toEqual([]);
	expect(await loadLearnedKeywordDefinitions()).toEqual([]);

	const second = await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });
	expect(second.promoted.length).toBeGreaterThan(0);
	expect(second.promoted.every(entry => entry.skill === "ralplan")).toBe(true);
	expect(second.promoted.every(entry => entry.learned === true)).toBe(true);
});

test("repeating one prompt never promotes it", async () => {
	const text = "이번 작업은 계획서부터 만들어줘";
	await observeRouting({ text, skill: "ralplan", ...calibrated });
	const again = await observeRouting({ text, skill: "ralplan", ...calibrated });
	expect(again.promoted).toEqual([]);
	expect((await summarizeLearnedKeywords()).entries).toEqual([]);
});

test("an ordinal answer needs a third prompt, because its confidence only ranks", async () => {
	const ordinal = { confidence: 0.99, calibrated: false } as const;
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...ordinal });
	const second = await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...ordinal });
	expect(second.promoted).toEqual([]);
	const third = await observeRouting({ text: "계획서 좀 빨리 만들어 봐", skill: "ralplan", ...ordinal });
	expect(third.promoted.length).toBeGreaterThan(0);
});

test("a learned pattern generalizes past the particle the literal table tripped on", async () => {
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });

	const learned = await loadLearnedKeywordDefinitions();
	// The hand-written table has "계획서 만들" as a literal substring, so this
	// phrasing — with a word wedged in the middle — misses it entirely.
	const unseen = "계획서 좀 빨리 만들어 봐";
	expect(detectPrimarySkillKeyword(unseen)).toBeNull();
	expect(detectPrimarySkillKeyword(unseen, learned)?.skill).toBe("ralplan");
});

test("one contradiction retracts a promoted pattern for good", async () => {
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });
	expect((await loadLearnedKeywordDefinitions()).length).toBeGreaterThan(0);

	// Same phrasing, routed to nothing. A phrase on both sides is not a rule.
	const retraction = await observeRouting({ text: "계획서 좀 빨리 만들어 봐", skill: null, ...calibrated });
	expect(retraction.retracted).toBeGreaterThan(0);
	expect(await loadLearnedKeywordDefinitions()).toEqual([]);

	// And it stays gone: two fresh agreeing prompts cannot resurrect it.
	await observeRouting({ text: "이번 작업은 계획서부터 만들어줘", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "먼저 계획서를 만들어서 보여줘", skill: "ralplan", ...calibrated });
	const revived = await loadLearnedKeywordDefinitions();
	expect(revived.some(entry => /계획/.test(entry.keyword) && /만들/.test(entry.keyword))).toBe(false);
});

test("a none answer opens no candidates of its own", async () => {
	await observeRouting({ text: "이 버그 좀 고쳐줘 로그인 실패한다", skill: null, ...calibrated });
	await observeRouting({ text: "이 버그 좀 고쳐줘 로그아웃 실패한다", skill: null, ...calibrated });
	const summary = await summarizeLearnedKeywords();
	expect(summary.entries).toEqual([]);
	expect(summary.candidates).toBe(0);
});

test("a hand-written keyword outranks a learned one for the same prompt", async () => {
	await observeRouting({ text: "장기 목표로 잡고 계획서 만들어", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "장기 목표로 두고 계획서를 만들어", skill: "ralplan", ...calibrated });
	const learned = await loadLearnedKeywordDefinitions();
	expect(learned.length).toBeGreaterThan(0);
	// "장기 목표로" is an enumerated ultragoal keyword. The probe phrasing dodges the
	// enumerated ralplan keyword ("계획서 만들") but still matches the learned ralplan
	// pattern, so the winner is decided purely by hand-written versus learned.
	const probe = "장기 목표로 잡고 계획서 좀 만들어";
	expect(detectPrimarySkillKeyword(probe)?.skill).toBe("ultragoal");
	expect(detectPrimarySkillKeyword(probe, learned)?.skill).toBe("ultragoal");
});

test("mining drops stopwords, bare numbers, and overlong tokens", () => {
	const shingles = mineShingles(`the 12345 plan document ${"x".repeat(40)}`);
	expect(shingles).toEqual(["plan\u0001document"]);
});

test("mining finds words in scripts that write no spaces", () => {
	// Chinese: the ICU dictionary knows 计划 and 审批 but not 文档, which comes back as
	// two single characters and is recovered as a bigram.
	expect(mineShingles("帮我写一个计划文档，然后审批")).toContain("计划\u0001文档");
	// Japanese: grammar is written in hiragana (を, して, から, ください) and is
	// dropped whole, so only the kanji content words are left to pair.
	const ja = mineShingles("要件定義をしてから実装してください");
	expect(ja).toEqual(["要件\u0001定義", "要件\u0001実装", "定義\u0001実装"]);
	// Thai: no spaces at all, still comes apart into words.
	expect(mineShingles("ต้องการแผนสถาปัตยกรรมก่อน")).toContain("แผน\u0001สถาปัตยกรรม");
});

test("mining keeps non-ASCII alphabets instead of dropping them", () => {
	expect(mineShingles("Créer un plan détaillé")).toContain("plan\u0001détaillé");
	expect(mineShingles("Составь план архитектуры")).toContain("план\u0001архитектуры");
	// Segmenter words still split on the punctuation they keep: a path is not a stem.
	expect(mineShingles("fix src/foo.ts quickly")).toEqual([
		"fix\u0001src",
		"fix\u0001foo",
		"src\u0001foo",
		"src\u0001quickly",
		"foo\u0001quickly",
	]);
});

test("a learned pattern fires in the language it was mined from", async () => {
	await observeRouting({ text: "架构风险很大，先给我一个需要审批的详细计划", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "先做一个需要审批的计划再动手", skill: "ralplan", ...calibrated });
	const learned = await loadLearnedKeywordDefinitions();
	expect(learned.length).toBeGreaterThan(0);
	expect(learned.every(entry => entry.skill === "ralplan")).toBe(true);
	const unseen = "改代码之前给我一个需要审批的计划";
	expect(detectPrimarySkillKeyword(unseen)).toBeNull();
	expect(detectPrimarySkillKeyword(unseen, learned)?.skill).toBe("ralplan");
});

test("a Cyrillic stem gets a word boundary, a Han stem does not", async () => {
	await observeRouting({ text: "Составь план миграции и жди одобрения", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "Нужен план миграции до кода", skill: "ralplan", ...calibrated });
	const learned = await loadLearnedKeywordDefinitions();
	const rule = learned.find(entry => entry.keyword === "план … миграции");
	expect(rule).toBeDefined();
	// "план" inside "выплан…" is another word; the boundary keeps it out in any alphabet.
	expect(rule?.pattern?.test("Опиши план миграции")).toBe(true);
	expect(rule?.pattern?.test("Опиши заплан миграции")).toBe(false);

	await observeRouting({ text: "先做架构设计再写代码", skill: "ralplan", ...calibrated });
	await observeRouting({ text: "需要一份架构设计文档", skill: "ralplan", ...calibrated });
	const han = (await loadLearnedKeywordDefinitions()).find(entry => entry.keyword === "架构 … 设计");
	expect(han).toBeDefined();
	// No spaces to anchor on: a substring inside a longer run must still match.
	expect(han?.pattern?.test("软件架构设计评审")).toBe(true);
	// A fullwidth full stop ends the thought the same way "." does.
	expect(han?.pattern?.test("架构。设计")).toBe(false);
});

test("a corrupt store degrades to empty instead of throwing", async () => {
	await Bun.write(join(dir, "learned.json"), "{ not json");
	resetLearnedKeywordCache();
	expect(await loadLearnedKeywordDefinitions()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Prompt triage
// ---------------------------------------------------------------------------

function stubBackend(result: DecisionResult, onRequest?: (request: Parameters<DecisionBackend["decide"]>[0]) => void) {
	return {
		name: "stub",
		decide: async (request: Parameters<DecisionBackend["decide"]>[0]) => {
			onRequest?.(request);
			return result;
		},
	} satisfies DecisionBackend;
}

function service(result: DecisionResult, onRequest?: (request: Parameters<DecisionBackend["decide"]>[0]) => void) {
	return createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [stubBackend(result, onRequest)],
	});
}

test("the UI criteria stay inside the backend's option ceiling", () => {
	const criteria = buildUiSkillCriteria();
	expect(Object.keys(criteria).length).toBeLessThanOrEqual(MAX_OPTIONS);
	expect(criteria.none).toBeTruthy();
	expect(criteria["appllama-app-design-skill"]).toContain("Expo");
});

test("workflow and UI ride one call, not two", async () => {
	let calls = 0;
	const triage = createPromptTriage(
		service(
			{
				answers: {
					workflow: { type: "choice", choice: "ralplan", confidence: 0.9 },
					uiSkill: { type: "choice", choice: "animate", confidence: 0.9 },
				},
				backend: "stub",
				model: "stub/model",
				calibrated: true,
				durationMs: 1,
			},
			() => {
				calls += 1;
			},
		),
	);
	const result = await triage({ text: "이 화면에 애니메이션 넣기 전에 계획부터 세워줘" });
	expect(calls).toBe(1);
	expect(result?.workflow).toBe("ralplan");
	expect(result?.uiSkill).toBe("animate");
});

test("an already-answered question is not sent to the model", async () => {
	let asked: string[] = [];
	const triage = createPromptTriage(
		service(
			{
				answers: { uiSkill: { type: "choice", choice: "animate", confidence: 0.9 } },
				backend: "stub",
				model: "stub/model",
				calibrated: true,
				durationMs: 1,
			},
			request => {
				asked = Object.keys(request.questions);
			},
		),
	);
	const result = await triage({ text: "이 화면에 애니메이션 좀 넣어줘", skipWorkflow: true });
	expect(asked).toEqual(["uiSkill"]);
	expect(result?.workflow).toBeNull();
	expect(result?.uiSkill).toBe("animate");
});

test("triage returns null rather than an empty call when nothing is unknown", async () => {
	let calls = 0;
	const triage = createPromptTriage(
		service({ answers: {}, backend: "stub", model: "stub/model", calibrated: true, durationMs: 1 }, () => {
			calls += 1;
		}),
	);
	expect(await triage({ text: "이 화면에 애니메이션 좀 넣어줘", skipWorkflow: true, skipUiSkill: true })).toBeNull();
	expect(calls).toBe(0);
});

test("a calibrated answer below the floor activates nothing", async () => {
	const triage = createPromptTriage(
		service({
			answers: {
				workflow: { type: "choice", choice: "ralplan", confidence: 0.5 },
				uiSkill: { type: "choice", choice: "animate", confidence: 0.5 },
			},
			backend: "stub",
			model: "stub/model",
			calibrated: true,
			durationMs: 1,
		}),
	);
	const result = await triage({ text: "뭔가 좀 해줘 화면이랑 계획이랑" });
	expect(result?.workflow).toBeNull();
	expect(result?.uiSkill).toBeNull();
});

test("an unknown choice id is discarded instead of activated", async () => {
	const triage = createPromptTriage(
		service({
			answers: { workflow: { type: "choice", choice: "definitely-not-a-skill", confidence: 0.99 } },
			backend: "stub",
			model: "stub/model",
			calibrated: true,
			durationMs: 1,
		}),
	);
	const result = await triage({ text: "이 화면에 애니메이션 넣기 전에 계획부터 세워줘", skipUiSkill: true });
	expect(result?.workflow).toBeNull();
});
