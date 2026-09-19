import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDecisionService } from "../src/decisions";
import { createSemanticSkillRouter } from "../src/decisions/skill-routing";
import type { DecisionBackend, DecisionResult } from "../src/decisions/types";
import { detectPrimarySkillKeyword, recordSkillActivation } from "../src/hooks/skill-state";
import { listActiveSkills } from "../src/skill-state/active-state";

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

test("routes Korean paraphrases the keyword table cannot see", async () => {
	const korean = [
		"요구사항이 아직 흐릿한데 나한테 질문해서 스펙을 뽑아줘",
		"이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘",
		"이 목표 끝까지 추적해줘. 중간에 잊지 말고",
		"작업 크니까 워커 여러 개로 나눠서 병렬로 돌려줘",
	];
	for (const prompt of korean) {
		// Baseline: the deterministic stage genuinely has nothing for these.
		expect(detectPrimarySkillKeyword(prompt)).toBeNull();
	}
	const route = createSemanticSkillRouter(serviceReturning("ralplan"));
	expect(await route(korean[1] as string)).toBe("ralplan");
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
		const prompt = "이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘";
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
