import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@sayknow-cli/agent-core";
import { getBundledModel, type ToolResultMessage } from "@sayknow-cli/ai";
import { AsyncJobManager } from "@sayknow-cli/coding-agent/async/job-manager";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";
import { TempDir } from "@sayknow-cli/utils";

const tempDirs: TempDir[] = [];

function messageText(message: { role: string; content?: unknown; customType?: string }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("\n");
}

function toolResult(toolName: string, text: string, details?: Record<string, unknown>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${toolName}`,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

async function settle(session: AgentSession, event: Parameters<Agent["emitExternalEvent"]>[0]): Promise<void> {
	session.agent.emitExternalEvent(event);
	// The fork has no awaitSessionSettlement(); drain the event handlers the way the
	// other emitExternalEvent tests do.
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await session.waitForIdle();
}

async function openSession(manager: SessionManager, modelRegistry: ModelRegistry) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		agentId: "checkpoint-switch",
	});
}

describe("AgentSession checkpoint across switchSession", () => {
	const sessions: AgentSession[] = [];
	const authStores: AuthStorage[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		AsyncJobManager.setInstance(undefined);
		for (const auth of authStores.splice(0)) auth.close();
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {
				// Best-effort fixture cleanup.
			}
		}
	});

	async function fixture() {
		const tempDir = TempDir.createSync("@skc-ckpt-switch-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		authStores.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
		return { cwd, authStorage, modelRegistry };
	}

	it("switchSession to another session file does not rewind that session with the previous checkpoint", async () => {
		const { cwd, modelRegistry } = await fixture();
		const sessionA = SessionManager.create(cwd, cwd);
		sessionA.appendMessage({ role: "user", content: "A-1", timestamp: 1 });
		sessionA.appendMessage({ role: "user", content: "A-2", timestamp: 2 });
		await sessionA.ensureOnDisk();

		const sessionB = SessionManager.create(cwd, cwd);
		for (let i = 1; i <= 8; i++) {
			sessionB.appendMessage({ role: "user", content: `B-${i}`, timestamp: i });
		}
		await sessionB.ensureOnDisk();
		const sessionBFile = sessionB.getSessionFile();
		if (!sessionBFile) throw new Error("Expected session B file");
		await sessionB.close();

		const session = await openSession(sessionA, modelRegistry);
		sessions.push(session);
		await settle(session, {
			type: "message_end",
			message: toolResult("checkpoint", "Checkpoint created.", {
				goal: "inspect A",
				startedAt: "2026-10-21T00:00:00.000Z",
			}),
		});
		const armed = session.getCheckpointState();
		expect(armed?.checkpointEntryId).toBe(sessionA.getLeafId());
		expect(armed?.checkpointMessageCount).toBeGreaterThan(0);

		expect(await session.switchSession(sessionBFile)).toBe(true);
		const loaded = session.agent.state.messages.map(message => messageText(message));
		for (let i = 1; i <= 8; i++) expect(loaded).toContain(`B-${i}`);
		await settle(session, {
			type: "message_end",
			message: toolResult("rewind", "Rewind requested.", { report: "cross-session rewind", rewound: true }),
		});
		await settle(session, {
			type: "turn_end",
			message: { role: "user", content: "end", timestamp: Date.now() },
			toolResults: [],
		});

		const texts = session.agent.state.messages.map(message => messageText(message));
		for (let i = 1; i <= 8; i++) expect(texts).toContain(`B-${i}`);
		expect(texts.some(text => text.includes("cross-session rewind"))).toBe(false);
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.sessionManager.getBranch().some(entry => entry.type === "branch_summary")).toBe(false);
	}, 30_000);

	it("same-session rewind keeps the checkpoint branch and still truncates only that session", async () => {
		const { cwd, modelRegistry } = await fixture();
		const manager = SessionManager.create(cwd, cwd);
		for (let i = 1; i <= 4; i++) {
			manager.appendMessage({ role: "user", content: `S-${i}`, timestamp: i });
		}
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const session = await openSession(manager, modelRegistry);
		sessions.push(session);
		expect(await session.switchSession(sessionFile)).toBe(true);
		await settle(session, {
			type: "message_end",
			message: toolResult("checkpoint", "Checkpoint created.", {
				goal: "inspect",
				startedAt: "2026-10-21T00:00:00.000Z",
			}),
		});
		const armed = session.getCheckpointState();
		expect(armed?.checkpointEntryId).toBeTruthy();
		const checkpointCount = armed?.checkpointMessageCount ?? 0;
		expect(checkpointCount).toBe(session.agent.state.messages.length);

		expect(await session.switchSession(sessionFile)).toBe(true);
		expect(session.getCheckpointState()?.checkpointEntryId).toBe(armed?.checkpointEntryId);

		for (const text of ["extra-1", "extra-2", "extra-3"]) {
			await settle(session, {
				type: "message_end",
				message: { role: "user", content: text, timestamp: Date.now() },
			});
		}
		expect(session.agent.state.messages.length).toBeGreaterThan(checkpointCount);

		await settle(session, {
			type: "message_end",
			message: toolResult("rewind", "Rewind requested.", { report: "same-session rewind", rewound: true }),
		});
		await settle(session, {
			type: "turn_end",
			message: { role: "user", content: "end", timestamp: Date.now() },
			toolResults: [],
		});

		const texts = session.agent.state.messages.map(message => messageText(message));
		for (let i = 1; i <= 4; i++) expect(texts).toContain(`S-${i}`);
		expect(texts.some(text => text.startsWith("extra-"))).toBe(false);
		expect(texts).toContain("same-session rewind");
		expect(session.getCheckpointState()).toBeUndefined();
		const entryId = armed?.checkpointEntryId;
		if (typeof entryId !== "string") throw new Error("Expected checkpoint entry id");
		const summary = session.sessionManager.getBranch().find(entry => entry.type === "branch_summary");
		expect(summary && "fromId" in summary ? summary.fromId : undefined).toBe(entryId);
	}, 30_000);
});
