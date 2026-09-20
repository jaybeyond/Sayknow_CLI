import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDecisionService } from "../src/decisions";
import { buildRoutingCriteria, createSemanticSkillRouter } from "../src/decisions/skill-routing";
import type { DecisionBackend, DecisionResult } from "../src/decisions/types";
import { detectPrimarySkillKeyword, recordSkillActivation } from "../src/hooks/skill-state";
import { type CanonicalSkcWorkflowSkill, listActiveSkills } from "../src/skill-state/active-state";

function serviceReturning(choice: string, seen?: { state?: string }): ReturnType<typeof createDecisionService> {
	const backend: DecisionBackend = {
		name: "stub",
		async decide(request): Promise<DecisionResult> {
			if (seen) seen.state = String(request.state);
			return {
				answers: { workflow: { type: "choice", choice } },
				backend: "stub",
				model: "stub/model",
				calibrated: false,
				durationMs: 1,
			};
		},
	};
	return createDecisionService({ registry: {} as never, settings: {} as never, enabled: true, backends: [backend] });
}

test("routes Korean paraphrases the keyword table still cannot see", async () => {
	// The keyword table gained Korean entries, so the semantic stage is no longer the
	// only thing that fires on Korean. These phrasings sit outside it on purpose: they
	// say the same thing without using any enumerated phrase, which is exactly the gap
	// the semantic stage exists to cover.
	const beyondKeywords = [
		"요구사항이 아직 흐릿한데 나한테 질문해서 스펙을 뽑아줘",
		"설계가 위험해 보여. 먼저 승인받을 문서부터 만들자",
		"이 일은 여러 사람이 나눠 맡아야 할 크기야",
	];
	for (const prompt of beyondKeywords) {
		expect(detectPrimarySkillKeyword(prompt)).toBeNull();
	}
	const route = createSemanticSkillRouter(serviceReturning("ralplan"));
	expect(await route(beyondKeywords[1] as string)).toBe("ralplan");
});

test("none is a real answer, not a routing failure", async () => {
	const route = createSemanticSkillRouter(serviceReturning("none"));
	expect(await route("이 테스트 왜 깨지는지 봐줘")).toBeNull();
});

test("an option outside the workflow set is discarded rather than trusted", async () => {
	const route = createSemanticSkillRouter(serviceReturning("definitely-not-a-skill"));
	expect(await route("아키텍처 리스크가 커서 계획이 필요해")).toBeNull();
});

test("a disabled service costs nothing and routes nothing", async () => {
	let called = false;
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		backends: [
			{
				name: "stub",
				async decide() {
					called = true;
					return null;
				},
			},
		],
	});
	expect(await createSemanticSkillRouter(service)("실행 전에 합의된 계획부터 세워줘")).toBeNull();
	expect(called).toBe(false);
});

test("short prompts never reach the model", async () => {
	const seen: { state?: string } = {};
	const route = createSemanticSkillRouter(serviceReturning("ralplan", seen));
	expect(await route("고고")).toBeNull();
	expect(seen.state).toBeUndefined();
});

test("long prompts are truncated before they are sent", async () => {
	const seen: { state?: string } = {};
	const route = createSemanticSkillRouter(serviceReturning("ralplan", seen));
	await route("계획 ".repeat(5000));
	expect((seen.state ?? "").length).toBeLessThanOrEqual(4000);
});

test("keyword match wins and the semantic stage is never consulted", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-routing-"));
	try {
		let consulted = false;
		const state = await recordSkillActivation({
			cwd,
			text: "consensus plan for the migration",
			resolveSkillSemantically: async () => {
				consulted = true;
				return "team";
			},
		});
		expect(consulted).toBe(false);
		expect(listActiveSkills(state).some(entry => entry.skill === "ralplan")).toBe(true);
	} finally {
		await fs.rm(cwd, { force: true, recursive: true });
	}
});

test("a throwing semantic stage leaves activation exactly as keyword-only", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-routing-"));
	try {
		const state = await recordSkillActivation({
			cwd,
			text: "이 테스트 왜 깨지는지 봐줘",
			resolveSkillSemantically: async () => {
				throw new Error("model offline");
			},
		});
		expect(state).toBeNull();
	} finally {
		await fs.rm(cwd, { force: true, recursive: true });
	}
});

test("semantic activation is recorded when the keyword table misses", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skc-routing-"));
	try {
		const prompt = "설계가 위험해 보여. 먼저 승인받을 문서부터 만들자";
		expect(detectPrimarySkillKeyword(prompt)).toBeNull();
		const state = await recordSkillActivation({
			cwd,
			text: prompt,
			resolveSkillSemantically: async () => "ralplan",
		});
		expect(listActiveSkills(state).some(entry => entry.skill === "ralplan")).toBe(true);
	} finally {
		await fs.rm(cwd, { force: true, recursive: true });
	}
});

test("Korean keywords close the deterministic gap without firing on ordinary work", () => {
	// Before these entries the table was English-only and recalled 0/9 on Korean.
	const shouldMatch: Array<[string, CanonicalSkcWorkflowSkill]> = [
		["추측하지 말고 모르는 건 다 물어봐", "deep-interview"],
		["뭘 만들지 정리가 안 됐어. 인터뷰하듯 파고들어줘", "deep-interview"],
		["이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘", "ralplan"],
		["여러 안 비교해서 검토받을 계획서 만들어줘", "ralplan"],
		["이 목표 끝까지 추적해줘. 중간에 잊지 말고", "ultragoal"],
		["장기 목표로 등록해두고 진행상황 계속 관리해", "ultragoal"],
		["작업 크니까 워커 여러 개로 나눠서 병렬로 돌려줘", "team"],
		["팀 구성해서 각자 파트 맡아 진행하게 해", "team"],
	];
	for (const [prompt, skill] of shouldMatch) {
		expect(detectPrimarySkillKeyword(prompt)?.skill).toBe(skill);
	}

	// A keyword fires with full authority and no confidence to fall back on, so a loose
	// entry activates a workflow the user never asked for. That is worse than missing
	// one, because the semantic stage still catches paraphrases behind it.
	const mustStaySilent = [
		"이 테스트 왜 깨지는지 봐줘",
		"README 오타 하나 고쳐",
		"이 함수 뭐하는 건지 설명해줘",
		"이 정규식 무슨 뜻이야?",
		"우리 서비스에 이 모델 붙이면 뭐가 좋아?",
		"계획 없이 그냥 바로 고쳐줘",
		"팀에서 쓰는 린트 설정 알려줘",
		"목표 달성률 계산하는 함수 보여줘",
	];
	for (const prompt of mustStaySilent) {
		expect(detectPrimarySkillKeyword(prompt)).toBeNull();
	}
});

test("a keyword hit no longer suppresses the semantic stage", async () => {
	// Regression: the router used to return early when `detectPrimarySkillKeyword`
	// matched, assuming the deterministic hook had already activated the workflow. That
	// hook only runs under the Codex host. In this session the early return meant an
	// enumerated keyword activated nothing at all — worse than before the keywords were
	// added, because the semantic stage had been handling those phrasings.
	const withKeyword = "이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘";
	expect(detectPrimarySkillKeyword(withKeyword)?.skill).toBe("ralplan");

	const seen: { state?: string } = {};
	const route = createSemanticSkillRouter(serviceReturning("ralplan", seen));
	expect(await route(withKeyword)).toBe("ralplan");
	// The prompt must actually reach the backend rather than being short-circuited.
	expect(seen.state).toBe(withKeyword);
});

test("a calibrated answer below the confidence floor does not activate", async () => {
	// Activation switches on the mutation guard, the Stop hook and the ask tool. The one
	// wrong answer observed against the hosted model reported 0.71, so a floor removes it.
	const backend: DecisionBackend = {
		name: "stub",
		async decide(): Promise<DecisionResult> {
			return {
				answers: { workflow: { type: "choice", choice: "ralplan", confidence: 0.71 } },
				backend: "stub",
				model: "stub/model",
				calibrated: true,
				durationMs: 1,
			};
		},
	};
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [backend],
	});
	expect(await createSemanticSkillRouter(service)("계획이 필요한 복잡한 작업이야")).toBeNull();
});

test("a calibrated answer at the floor activates", async () => {
	const backend: DecisionBackend = {
		name: "stub",
		async decide(): Promise<DecisionResult> {
			return {
				answers: { workflow: { type: "choice", choice: "ralplan", confidence: 0.75 } },
				backend: "stub",
				model: "stub/model",
				calibrated: true,
				durationMs: 1,
			};
		},
	};
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [backend],
	});
	expect(await createSemanticSkillRouter(service)("계획이 필요한 복잡한 작업이야")).toBe("ralplan");
});

test("an uncalibrated backend is not gated on a number it did not really produce", async () => {
	// The LLM backend answers through a forced enum and reports calibrated:false. It has
	// no confidence to compare, so applying a floor would just be superstition.
	const backend: DecisionBackend = {
		name: "llm",
		async decide(): Promise<DecisionResult> {
			return {
				answers: { workflow: { type: "choice", choice: "team" } },
				backend: "llm",
				model: "some/small-model",
				calibrated: false,
				durationMs: 1,
			};
		},
	};
	const service = createDecisionService({
		registry: {} as never,
		settings: {} as never,
		enabled: true,
		backends: [backend],
	});
	expect(await createSemanticSkillRouter(service)("여러 갈래로 나눠서 같이 진행하자")).toBe("team");
});

test("deep-interview covers an instruction to ask, not only a vague spec", () => {
	// The criteria used to describe a property of the request ("vague about what to
	// build"), so a direct order about how to proceed — the request is not vague at all —
	// resolved to none. This was the only miss in the 23-case set. The wording now scopes
	// to the behaviour being asked for.
	const criteria = buildRoutingCriteria();
	expect(criteria["deep-interview"]).toMatch(/ask rather than assume/i);
	expect(criteria["deep-interview"]).not.toMatch(/vague about what to build/i);
	// Every workflow plus an explicit escape hatch; without `none` the model must pick a
	// workflow for prompts that need none of them.
	expect(Object.keys(criteria).sort()).toEqual(["deep-interview", "none", "ralplan", "team", "ultragoal"].sort());
});

test("the keyword table is what a Korean workflow phrasing hits, with no model involved", () => {
	// These used to reach only the Codex `UserPromptSubmit` hook, which this host never
	// fires, so in an SKC session they activated nothing at all. The session now runs the
	// same table itself — free, deterministic, and independent of `decisions.enabled`.
	const cases: Array<[string, CanonicalSkcWorkflowSkill]> = [
		["이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘", "ralplan"],
		["추측하지 말고 모르는 건 다 물어봐", "deep-interview"],
		["이 목표 끝까지 추적해줘", "ultragoal"],
		["작업 크니까 워커 여러 개로 나눠서 병렬로 돌려줘", "team"],
	];
	for (const [prompt, skill] of cases) expect(detectPrimarySkillKeyword(prompt)?.skill).toBe(skill);
});
