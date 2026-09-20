#!/usr/bin/env bun
/**
 * Measure workflow routing against the model the user is logged into.
 *
 * Runs the real `decisions/llm-backend` — same forced tool call, same enum
 * constraint, same model role resolution the session uses — over a fixed set of
 * prompts, and compares it with the deterministic keyword stage it is meant to
 * back up.
 *
 *   bun scripts/eval-skill-routing.ts [--repeat N] [--json out.json] [--backend typesafe|llm]
 *
 * `--backend` pins one backend so the two can be compared head to head. Without it the
 * normal resolution order applies (TypeSafe when a key exists, else the logged-in model).
 *
 * The keyword baseline is recomputed here rather than quoted, so the comparison
 * can never drift away from what `skill-keywords.ts` currently contains.
 */
import { ModelRegistry } from "../src/config/model-registry";
import { resolveRoleSelection } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { createDecisionService, createLlmDecisionBackend, createTypeSafeDecisionBackend } from "../src/decisions";
import { createSemanticSkillRouter } from "../src/decisions/skill-routing";
import { detectPrimarySkillKeyword } from "../src/hooks/skill-state";
import { discoverAuthStorage } from "../src/sdk";

type Expected = "deep-interview" | "ralplan" | "ultragoal" | "team" | null;
interface Case {
	prompt: string;
	expect: Expected;
	lang: "ko" | "en";
}

const CASES: Case[] = [
	{ prompt: "요구사항이 아직 흐릿한데 나한테 질문해서 스펙을 뽑아줘", expect: "deep-interview", lang: "ko" },
	{ prompt: "뭘 만들지 정리가 안 됐어. 인터뷰하듯 파고들어줘", expect: "deep-interview", lang: "ko" },
	{ prompt: "추측하지 말고 모르는 건 다 물어봐", expect: "deep-interview", lang: "ko" },
	{ prompt: "Ask me questions until the requirements are actually clear", expect: "deep-interview", lang: "en" },
	{ prompt: "don't assume anything, dig into what I actually need", expect: "deep-interview", lang: "en" },
	{ prompt: "이거 아키텍처 리스크 커. 실행 전에 합의된 계획부터 세워줘", expect: "ralplan", lang: "ko" },
	{ prompt: "여러 안 비교해서 검토받을 계획서 만들어줘", expect: "ralplan", lang: "ko" },
	{ prompt: "Draft a deliberate plan and stop for my approval before touching code", expect: "ralplan", lang: "en" },
	{ prompt: "consensus plan for the migration", expect: "ralplan", lang: "en" },
	{ prompt: "이 목표 끝까지 추적해줘. 중간에 잊지 말고", expect: "ultragoal", lang: "ko" },
	{ prompt: "장기 목표로 등록해두고 진행상황 계속 관리해", expect: "ultragoal", lang: "ko" },
	{ prompt: "Track this objective until every deliverable is verified", expect: "ultragoal", lang: "en" },
	{ prompt: "ultragoal this and keep the ledger updated", expect: "ultragoal", lang: "en" },
	{ prompt: "작업 크니까 워커 여러 개로 나눠서 병렬로 돌려줘", expect: "team", lang: "ko" },
	{ prompt: "팀 구성해서 각자 파트 맡아 진행하게 해", expect: "team", lang: "ko" },
	{ prompt: "Spin up coordinated workers for these three slices", expect: "team", lang: "en" },
	{ prompt: "coordinated team run on the backlog", expect: "team", lang: "en" },
	{ prompt: "이 테스트 왜 깨지는지 봐줘", expect: null, lang: "ko" },
	{ prompt: "README 오타 하나 고쳐", expect: null, lang: "ko" },
	{ prompt: "이 함수 뭐하는 건지 설명해줘", expect: null, lang: "ko" },
	{ prompt: "우리 서비스에 이 모델 붙이면 뭐가 좋아?", expect: null, lang: "ko" },
	{ prompt: "fix the failing lint rule in src/utils.ts", expect: null, lang: "en" },
	{ prompt: "what does this regex do?", expect: null, lang: "en" },
];

function pct(hit: number, total: number): string {
	return total === 0 ? "n/a" : `${hit}/${total} (${((hit / total) * 100).toFixed(0)}%)`;
}

async function main(): Promise<void> {
	const repeat = Math.max(1, Number(Bun.argv[Bun.argv.indexOf("--repeat") + 1]) || 1);
	const jsonIndex = Bun.argv.indexOf("--json");
	const jsonPath = jsonIndex > 0 ? Bun.argv[jsonIndex + 1] : undefined;

	const settings = await Settings.init();
	const registry = new ModelRegistry(await discoverAuthStorage());
	await registry.refresh();
	registry.applyConfiguredModelBindings(settings);
	const backendIndex = Bun.argv.indexOf("--backend");
	const pinned = backendIndex > 0 ? Bun.argv[backendIndex + 1] : undefined;
	const model = resolveRoleSelection(["smol", "default"], settings, registry.getAvailable(), registry)?.model;
	if (!model && pinned !== "typesafe") throw new Error("no model available — log in first");

	// `--model provider/id` pins one concrete model so candidates can be compared on
	// measured accuracy and latency instead of on guesses about what "small" means.
	const modelIndex = Bun.argv.indexOf("--model");
	const wanted = modelIndex > 0 ? Bun.argv[modelIndex + 1] : undefined;
	const forced = wanted
		? registry.getAvailable().find(m => `${m.provider}/${m.id}` === wanted || m.id === wanted)
		: undefined;
	if (wanted && !forced) throw new Error(`model not available: ${wanted}`);

	const backends =
		pinned === "typesafe"
			? [createTypeSafeDecisionBackend({ registry })]
			: pinned === "llm" || forced
				? [createLlmDecisionBackend({ registry, settings, model: forced })]
				: undefined;
	// The llm backend now selects its own small model, so the script cannot label the run
	// from role resolution — doing so reported opus while a 4B model actually answered.
	const label =
		pinned === "typesafe" ? "typesafe/jev" : pinned === "llm" ? "llm/auto-small" : `${model?.provider}/${model?.id}`;
	console.log(`backend: ${pinned ?? "auto"}   model: ${label}   repeat: ${repeat}\n`);

	const route = createSemanticSkillRouter(
		createDecisionService({ registry, settings, enabled: true, timeoutMs: 30_000, backends }),
	);

	const rows: Array<{ case: Case; keyword: Expected; semantic: Expected; ms: number }> = [];
	for (const testCase of CASES) {
		for (let run = 0; run < repeat; run++) {
			const keyword = (detectPrimarySkillKeyword(testCase.prompt)?.skill ?? null) as Expected;
			const started = Date.now();
			const semantic = (await route(testCase.prompt)) as Expected;
			rows.push({ case: testCase, keyword, semantic, ms: Date.now() - started });
			const hybrid = keyword ?? semantic;
			const mark = hybrid === testCase.expect ? "OK  " : "MISS";
			console.log(
				`${mark} [${testCase.lang}] want=${testCase.expect ?? "none"} kw=${keyword ?? "-"} sem=${semantic ?? "none"} ${Date.now() - started}ms :: ${testCase.prompt.slice(0, 44)}`,
			);
		}
	}

	const score = (pick: (row: (typeof rows)[number]) => Expected, filter: (row: (typeof rows)[number]) => boolean) => {
		const subset = rows.filter(filter);
		return [subset.filter(row => pick(row) === row.case.expect).length, subset.length] as const;
	};
	const positives = (row: (typeof rows)[number]) => row.case.expect !== null;
	const negatives = (row: (typeof rows)[number]) => row.case.expect === null;
	const ko = (row: (typeof rows)[number]) => positives(row) && row.case.lang === "ko";
	const en = (row: (typeof rows)[number]) => positives(row) && row.case.lang === "en";
	const hybrid = (row: (typeof rows)[number]) => row.keyword ?? row.semantic;

	console.log("\n=== stage comparison ===");
	for (const [label, pick] of [
		["keyword only (Codex hook)", (row: (typeof rows)[number]) => row.keyword],
		["semantic only (SHIPPED)", (row: (typeof rows)[number]) => row.semantic],
		["keyword+semantic (upper bound)", hybrid],
	] as const) {
		console.log(
			`${label.padEnd(32)} all ${pct(...score(pick, () => true))}  ko ${pct(...score(pick, ko))}  en ${pct(...score(pick, en))}  clean-negatives ${pct(...score(pick, negatives))}`,
		);
	}

	const latencies = rows.map(row => row.ms).sort((a, b) => a - b);
	console.log(
		`\nlatency p50 ${latencies[Math.floor(latencies.length / 2)]}ms  p95 ${latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)]}ms  max ${latencies.at(-1)}ms`,
	);

	// Report against what actually ships in this host, not against the upper bound.
	const misses = rows.filter(row => row.semantic !== row.case.expect);
	if (misses.length > 0) {
		console.log("\n=== misses in shipped configuration (semantic only) ===");
		for (const row of misses)
			console.log(
				`  [${row.case.lang}] want=${row.case.expect ?? "none"} got=${row.semantic ?? "none"} :: ${row.case.prompt}`,
			);
	}

	if (jsonPath) {
		await Bun.write(
			jsonPath,
			JSON.stringify(
				{
					// Must be the backend that actually answered, not the chat model that was
					// resolved for the fallback path — a mislabelled run poisons later comparisons.
					model: label,
					backend: pinned ?? "auto",
					repeat,
					rows: rows.map(r => ({ ...r.case, ...r, case: undefined })),
				},
				null,
				2,
			),
		);
		console.log(`\nwrote ${jsonPath}`);
	}
}

await main();
