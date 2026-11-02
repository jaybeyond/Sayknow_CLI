import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@sayknow-cli/agent-core";
import { getBundledModel } from "@sayknow-cli/ai/models";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import type { Skill } from "@sayknow-cli/coding-agent/extensibility/skills";
import { ensureWorkflowSkillActivationState } from "@sayknow-cli/coding-agent/hooks/skill-state";
import { initTheme } from "@sayknow-cli/coding-agent/modes/theme/theme";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@sayknow-cli/coding-agent/session/messages";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

const STEP_MARKER = "ULTRAGOAL_STEP_FIVE_MARKER";
const RESTORE_TYPE = "workflow-skill-context";

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentSession workflow skill restore after compaction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-workflow-skill-restore-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const skillDir = path.join(tempDir.path(), "skills", "ultragoal");
		fs.mkdirSync(skillDir, { recursive: true });
		const skillFile = path.join(skillDir, "SKILL.md");
		fs.writeFileSync(skillFile, `---\nname: ultragoal\n---\nStep 5: ${STEP_MARKER}\n`);
		const skill: Skill = {
			name: "ultragoal",
			description: "test workflow",
			filePath: skillFile,
			baseDir: skillDir,
			source: "test",
		};
		sessionManager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				getApiKey: provider => `${provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "todo.reminders": false }),
			modelRegistry: new ModelRegistry(authStorage),
			skills: [skill],
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function activateUltragoal(): Promise<void> {
		await ensureWorkflowSkillActivationState({
			cwd: tempDir.path(),
			skill: "ultragoal",
			sessionId: sessionManager.getSessionId(),
		});
	}

	/** Record the skill invocation on the branch; `live` keeps it in the model's context too. */
	function invokeSkill(live: boolean): void {
		const details = { name: "ultragoal", args: "track plan.md" };
		sessionManager.appendCustomMessageEntry(SKILL_PROMPT_MESSAGE_TYPE, "skill body", true, details, "user");
		if (live) {
			session.agent.appendMessage({
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "skill body",
				display: true,
				details,
				attribution: "user",
				timestamp: Date.now(),
			});
		}
	}

	async function promptedMessages(): Promise<AgentMessage[]> {
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		await session.prompt("next step");
		const call = promptSpy.mock.calls.at(-1)?.[0];
		promptSpy.mockRestore();
		return (Array.isArray(call) ? call : [call]) as AgentMessage[];
	}

	function restored(messages: readonly AgentMessage[]): AgentMessage[] {
		return messages.filter(message => message.role === "custom" && message.customType === RESTORE_TYPE);
	}

	it("re-attaches the active workflow's instructions once compaction removed them", async () => {
		await activateUltragoal();
		invokeSkill(false);

		const messages = await promptedMessages();
		const copies = restored(messages);
		expect(copies).toHaveLength(1);
		expect(JSON.stringify(copies[0])).toContain(STEP_MARKER);
		expect(JSON.stringify(copies[0])).toContain("track plan.md");

		// Once the restored copy is in context, later prompts do not repeat it.
		for (const message of copies) session.agent.appendMessage(message);
		expect(restored(await promptedMessages())).toHaveLength(0);
	});

	it("adds nothing while the original skill prompt is still in context", async () => {
		await activateUltragoal();
		invokeSkill(true);
		expect(restored(await promptedMessages())).toHaveLength(0);
	});

	it("ignores an active workflow row this branch never invoked", async () => {
		await activateUltragoal();
		expect(restored(await promptedMessages())).toHaveLength(0);
	});

	it("queues the instructions before resuming a run compacted mid-loop", async () => {
		await activateUltragoal();
		invokeSkill(false);
		const steerSpy = vi.spyOn(session.agent, "steer");
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		session.agent.emitExternalEvent({
			type: "agent_end",
			messages: [],
			stopReason: "maintenance",
			maintenanceOutcome: "compacted",
		});
		await Bun.sleep(150);
		await session.waitForIdle();
		const steered = steerSpy.mock.calls.map(call => call[0]);
		expect(restored(steered)).toHaveLength(1);
		expect(continueSpy).toHaveBeenCalled();
		expect(steerSpy.mock.invocationCallOrder[0]).toBeLessThan(continueSpy.mock.invocationCallOrder[0]!);
	});

	it("resumes the compacted run before prompt() returns, so print mode does not exit early", async () => {
		await activateUltragoal();
		invokeSkill(false);
		const { promise: continued, resolve: finishContinue } = Promise.withResolvers<void>();
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(() => continued);
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			session.agent.emitExternalEvent({
				type: "agent_end",
				messages: [],
				stopReason: "maintenance",
				maintenanceOutcome: "compacted",
			});
		});
		let promptReturned = false;
		const prompted = session.prompt("work").then(() => {
			promptReturned = true;
		});
		for (let i = 0; i < 200 && continueSpy.mock.calls.length === 0; i++) await Bun.sleep(5);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		// print mode exits as soon as prompt() returns; it must outlive the resumed run.
		await Bun.sleep(30);
		expect(promptReturned).toBe(false);
		finishContinue();
		await prompted;
		expect(promptReturned).toBe(true);
	});
});
