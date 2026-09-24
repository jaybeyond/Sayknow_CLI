import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, AgentBusyError } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Model } from "@sayknow-cli/ai";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import {
	loadLearnedKeywordDefinitions,
	resetLearnedKeywordCache,
	setLearnedKeywordStorePath,
} from "../src/decisions/keyword-learning";
import { clearDeadModelCache } from "../src/decisions/llm-backend";
import { getSkillActiveStatePaths, listActiveSkills } from "../src/skill-state/active-state";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/**
 * Stage two of workflow routing, through the host wiring: a genuine user prompt with
 * no keyword is sent to a small model over the session's own `streamFn`, and a
 * confident answer seeds the workflow before the turn's first request.
 *
 * The transport is scripted, so what is under test is the wiring — which model is
 * asked, when, what happens to the answer, and that the routing window behaves like
 * a turn for concurrency and abort.
 */
describe("AgentSession semantic workflow routing", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		clearDeadModelCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skc-semantic-routing-"));
		// Learning is on by default and the store is user-global, so without this a
		// test run would promote patterns into the developer's own home directory.
		setLearnedKeywordStorePath(path.join(tempDir, "learned-skill-keywords.json"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		setLearnedKeywordStorePath(undefined);
		resetLearnedKeywordCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	interface Scripted {
		/** Answer the routing tool call with this workflow; `hang` never answers until aborted. */
		route: string | "hang";
		/** Answer the UI half of the same call. Omitted means the model returned no pick. */
		uiSkill?: string;
	}

	async function createSession(script: Scripted, config: { semanticWorkflowRouting?: boolean } = {}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const calls: { model: string; toolChoice: unknown; questions: string[] }[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (streamModel: Model, context, options) => {
				const decisionTool = context?.tools?.find(tool => tool.name === "emit_decisions");
				const schema = decisionTool?.parameters as { properties?: Record<string, unknown> } | undefined;
				calls.push({
					model: streamModel.id,
					toolChoice: options?.toolChoice,
					questions: Object.keys(schema?.properties ?? {}),
				});
				const stream = new AssistantMessageEventStream();
				const isRoutingCall =
					typeof options?.toolChoice === "object" &&
					(options.toolChoice as { name?: string }).name === "emit_decisions";
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (isRoutingCall && script.route !== "hang") {
						const answer: AssistantMessage = {
							...createAssistantMessage(""),
							content: [
								{
									type: "toolCall",
									id: "t",
									name: "emit_decisions",
									arguments: {
										workflow: script.route,
										...(script.uiSkill ? { uiSkill: script.uiSkill } : {}),
									},
								},
							],
							stopReason: "toolUse",
						};
						stream.push({ type: "done", reason: "toolUse", message: answer });
						return;
					}
					// The main turn (and a hanging routing call) end only on abort.
					options?.signal?.addEventListener(
						"abort",
						() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
						{ once: true },
					);
				});
				return stream;
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory(tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			...config,
		});
		return { session, calls, sessionManager };
	}

	async function activeSkills(sessionManager: SessionManager): Promise<string[]> {
		const { sessionPath } = getSkillActiveStatePaths(tempDir, sessionManager.getSessionId());
		if (!fs.existsSync(sessionPath)) return [];
		return listActiveSkills(JSON.parse(fs.readFileSync(sessionPath, "utf8"))).map(entry => entry.skill);
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	it("asks the session provider's small model over the session transport and seeds the answer before the turn", async () => {
		const { session, calls, sessionManager } = await createSession(
			{ route: "ralplan" },
			{ semanticWorkflowRouting: true },
		);
		const turn = session.prompt("결제 모듈 리팩터링인데 순서 잘못 잡으면 터져. 실행 전에 안 잡고 컨펌받자");
		await waitFor(() => calls.length >= 2);

		// First call is the routing decision on the provider's small model, forced onto the
		// decisions tool; the second is the real turn on the session model.
		expect(calls[0]?.model).toMatch(/haiku/);
		expect(calls[0]?.toolChoice).toEqual({ type: "tool", name: "emit_decisions" });
		expect(calls[1]?.model).toBe("claude-sonnet-4-5");
		expect(await activeSkills(sessionManager)).toContain("ralplan");

		await session.abort();
		await turn.catch(() => {});
	});

	it("a bare session never routes: the scripted transport sees only the turn", async () => {
		const { session, calls, sessionManager } = await createSession({ route: "ralplan" });
		const turn = session.prompt("결제 모듈 리팩터링인데 순서 잘못 잡으면 터져. 실행 전에 안 잡고 컨펌받자");
		await waitFor(() => calls.length >= 1);
		await Bun.sleep(50);
		expect(calls.map(call => call.model)).toEqual(["claude-sonnet-4-5"]);
		expect(await activeSkills(sessionManager)).toEqual([]);
		await session.abort();
		await turn.catch(() => {});
	});

	it("the setting turns stage two off even when the host wired it", async () => {
		const { session, calls } = await createSession({ route: "ralplan" }, { semanticWorkflowRouting: true });
		session.settings.set("decisions.enabled", false);
		const turn = session.prompt("결제 모듈 리팩터링인데 순서 잘못 잡으면 터져. 실행 전에 안 잡고 컨펌받자");
		await waitFor(() => calls.length >= 1);
		await Bun.sleep(50);
		expect(calls.map(call => call.model)).toEqual(["claude-sonnet-4-5"]);
		await session.abort();
		await turn.catch(() => {});
	});

	it("routing counts as streaming: a second prompt rejects and abort cancels the routing call", async () => {
		const { session, calls } = await createSession({ route: "hang" }, { semanticWorkflowRouting: true });
		const started = Date.now();
		const turn = session.prompt("결제 모듈 리팩터링인데 순서 잘못 잡으면 터져. 실행 전에 안 잡고 컨펌받자");
		await waitFor(() => session.isStreaming);
		await expect(session.prompt("두 번째 메시지입니다")).rejects.toBeInstanceOf(AgentBusyError);

		await session.abort();
		await expect(turn).rejects.toThrow(/cancelled/);
		// At most the routing call was made (abort can land before the transport is even
		// reached), never the turn, and nothing waited out an attempt budget.
		expect(calls.length).toBeLessThanOrEqual(1);
		expect(calls.map(call => call.model)).not.toContain("claude-sonnet-4-5");
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(session.isStreaming).toBe(false);
	});

	it("an answer of none leaves the turn alone", async () => {
		const { session, calls, sessionManager } = await createSession(
			{ route: "none" },
			{ semanticWorkflowRouting: true },
		);
		const turn = session.prompt("README 첫 줄에 프로젝트 설명 한 문장만 추가해줘");
		await waitFor(() => calls.length >= 2);
		expect(calls[1]?.model).toBe("claude-sonnet-4-5");
		expect(await activeSkills(sessionManager)).toEqual([]);
		await session.abort();
		await turn.catch(() => {});
	});

	it("workflow and UI skill are two questions in one call, not two calls", async () => {
		const { session, calls } = await createSession(
			{ route: "ralplan", uiSkill: "animate" },
			{ semanticWorkflowRouting: true },
		);
		// No enumerated workflow keyword and no UI pattern: both questions are open.
		const turn = session.prompt("이 부분 손보기 전에 어떻게 갈지부터 같이 정하고 넘어가자");
		await waitFor(() => calls.length >= 2);

		expect(calls[0]?.questions).toEqual(["workflow", "uiSkill"]);
		// One routing call, then the turn. Adding UI routing cost no round trip.
		expect(calls.filter(call => call.questions.length > 0).length).toBe(1);

		// The pick has to become a real message in the turn the session assembles,
		// not just a field on the session.
		const prelude = session.agent.state.messages
			.filter(message => message.role === "developer")
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.map(part => (part.type === "text" ? part.text : ""))
			.find(text => text.includes("frontend UI/UX work"));
		expect(prelude).toContain("`animate`");
		expect(prelude).toContain("semantic match");
		expect(prelude).toContain("`emil-design-eng`");

		await session.abort();
		await turn.catch(() => {});
	});

	it("a matching UI pattern answers for free and the model is never asked", async () => {
		const { session, calls } = await createSession({ route: "none" }, { semanticWorkflowRouting: true });
		const turn = session.prompt("이 버튼 컴포넌트 레이아웃 좀 다듬어줘");
		await waitFor(() => calls.length >= 2);

		expect(calls[0]?.questions).toEqual(["workflow"]);
		const prelude = session.agent.state.messages
			.filter(message => message.role === "developer")
			.flatMap(message => (Array.isArray(message.content) ? message.content : []))
			.map(part => (part.type === "text" ? part.text : ""))
			.find(text => text.includes("frontend UI/UX work"));
		expect(prelude).toContain("matched");
		expect(prelude).not.toContain("semantic match");

		await session.abort();
		await turn.catch(() => {});
	});

	it("a pattern the router resolves twice stops costing a model call", async () => {
		// The scripted transport is the LLM backend, which reports `calibrated: false`,
		// so its confidence only ranks and the store demands a third independent prompt.
		const prompts = [
			"이 부분 손보기 전에 구현 순서부터 같이 정하자",
			"배포 건드리기 전에 구현 순서를 먼저 정하고 가자",
			"리팩터링 들어가기 전에 구현 순서 좀 맞춰두자",
		];
		for (const [index, text] of prompts.entries()) {
			session = undefined;
			const host = await createSession({ route: "ralplan" }, { semanticWorkflowRouting: true });
			const turn = host.session.prompt(text);
			await waitFor(() => host.calls.length >= 2);
			await host.session.abort();
			await turn.catch(() => {});
			await host.session.dispose();
			// Nothing is promoted off one or two prompts, however confident the answer.
			if (index < prompts.length - 1) expect(await loadLearnedKeywordDefinitions()).toEqual([]);
		}

		const learned = await loadLearnedKeywordDefinitions();
		expect(learned.length).toBeGreaterThan(0);
		expect(learned.every(entry => entry.skill === "ralplan")).toBe(true);
		expect(learned.every(entry => entry.learned === true)).toBe(true);
	});
});
