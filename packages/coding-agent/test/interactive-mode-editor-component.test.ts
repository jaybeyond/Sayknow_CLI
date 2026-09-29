import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@sayknow-cli/agent-core";
import type { AssistantMessage } from "@sayknow-cli/ai";
import { formatKeyHint, formatKeyHints, type KeyDisplayContext } from "@sayknow-cli/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@sayknow-cli/coding-agent/config/settings";
import { t } from "@sayknow-cli/coding-agent/i18n/index";
import { WelcomeComponent } from "@sayknow-cli/coding-agent/modes/components/welcome";
import { initTheme, theme } from "@sayknow-cli/coding-agent/modes/theme/theme";
import {
	CURSOR_MARKER,
	ImageProtocol,
	setKittyProtocolActive,
	setTerminalImageProtocol,
	TERMINAL,
	Text,
	visibleWidth,
} from "@sayknow-cli/tui";
import { TempDir } from "@sayknow-cli/utils";
import { ModelRegistry } from "../src/config/model-registry";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "../src/extensibility/extensions";
import { CustomEditor } from "../src/modes/components/custom-editor";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import {
	associateSessionMessageEntryId,
	CURRENT_SESSION_VERSION,
	type SessionContext,
	SessionManager,
} from "../src/session/session-manager";

class TestModalEditor extends CustomEditor {}
function stripRenderControls(line: string): string {
	return stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, ""));
}

function forceTerminalSize(mode: InteractiveMode, columns: number, rows: number): void {
	Object.defineProperty(mode.ui.terminal, "columns", { configurable: true, get: () => columns });
	Object.defineProperty(mode.ui.terminal, "rows", { configurable: true, get: () => rows });
}

const injectedKeyDisplayContext: KeyDisplayContext = {
	platform: process.platform === "darwin" ? "win32" : "darwin",
};

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			injectedKeyDisplayContext,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("applies viewport policy inside the real destructive rebuild methods", () => {
		const reset = vi.spyOn(mode.ui, "resetViewportAnchorIntent");
		const reconcile = vi.spyOn(mode.ui, "prepareViewportAnchorForTranscriptRebuild");
		vi.spyOn(mode, "renderSessionContext").mockImplementation(() => undefined);

		mode.rebuildChatFromMessages("replace-identity");
		expect(reset).toHaveBeenCalledTimes(1);
		expect(reconcile).not.toHaveBeenCalled();

		mode.rebuildInitialMessages("reconcile-same-transcript", {
			messages: [],
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			configuredModelChains: {},
			injectedTtsrRules: [],
			selectedMCPToolNames: [],
			hasPersistedMCPToolSelection: false,
			mode: "none",
		});
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("reports output revision changes while chrome-only editor reflow reports no output mutation", async () => {
		await mode.init();
		const report = vi.spyOn(mode.ui, "setViewportOutputSource");

		mode.recordVisibleTranscriptMutation();
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0]?.[0]).toMatchObject({ revision: 1n });

		report.mockClear();
		mode.editor.setText("draft that changes editor chrome only");
		mode.updateEditorChrome();
		expect(report).not.toHaveBeenCalled();
	});

	it("renders an idle extension custom message through the real rebuild boundary", async () => {
		let actions: ExtensionActions | undefined;
		const extensionRunner = {
			initialize(
				capturedActions: ExtensionActions,
				_contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				actions = capturedActions;
			},
			getMessageRenderer: () => undefined,
		};
		Object.defineProperty(session, "extensionRunner", {
			configurable: true,
			value: extensionRunner as unknown as AgentSession["extensionRunner"],
		});
		const reconcile = vi.spyOn(mode.ui, "prepareViewportAnchorForTranscriptRebuild");
		new ExtensionUiController(mode).initializeHookRunner({} as ExtensionUIContext, false);
		if (!actions) throw new Error("Extension actions were not initialized");

		actions.sendMessage({ customType: "test", content: "visible extension message", display: true });
		await Bun.sleep(0);

		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.render(80).join("\n")).toContain("visible extension message");
	});

	it("renders the default composer as an open rail, not a box", () => {
		const lines = mode.editor.render(48).map(stripRenderControls);

		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(lines.every(line => line.startsWith(`${theme.rail.user} `))).toBe(true);
		const joined = lines.join("\n");
		expect(joined).toContain("Type your message...");
		for (const boxGlyph of ["╭", "╮", "╰", "╯", "│", "›"]) expect(joined).not.toContain(boxGlyph);
	});

	it("keeps transcript anchoring registered across live IRC sidebar settings", () => {
		const setViewportAnchor = vi.spyOn(mode.ui, "setViewportAnchorComponent");
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		mode.settings.set("irc.sidebar.enabled", false);
		mode.applyIrcSidebarAvailability(false);
		expect(setViewportAnchor).not.toHaveBeenCalled();
	});

	it("captures a null resolved toggle key from an explicitly empty binding and suppresses the live hint", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		vi.spyOn(mode.keybindings, "getKeys").mockImplementation(action =>
			action === "app.irc.sidebar.toggle" ? [] : [],
		);

		const arrival = mode.captureIrcArrivalSnapshot();
		expect(arrival.resolvedToggleKey).toBeNull();

		const components = mode.addLiveIrcObservationToChat(
			{
				observationId: "unbound-key-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "hint must be suppressed",
				timestamp: 1,
			},
			arrival,
		);
		const rendered = components.flatMap(component => component.render(120)).map(line => Bun.stripANSI(line));
		expect(rendered.join("\n")).not.toContain("opens sidebar");
	});

	it("suppresses a toggle hint when a built-in editor action owns the configured key", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		vi.spyOn(mode.keybindings, "getKeys").mockImplementation(action =>
			action === "app.irc.sidebar.toggle" ? ["ctrl+c", "alt+i"] : [],
		);
		vi.spyOn(mode.editor, "hasActionKey").mockImplementation(key => key === "ctrl+c");

		expect(mode.captureIrcArrivalSnapshot().resolvedToggleKey).toBe("alt+i");
	});

	it("converts requested-visible state to a closed arrival snapshot below the sidebar width floor", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();

		forceTerminalSize(mode, 64, 24);
		const narrow = mode.captureIrcArrivalSnapshot();
		expect(narrow.panelVisible).toBe(false);

		forceTerminalSize(mode, 65, 24);
		const wideEnough = mode.captureIrcArrivalSnapshot();
		expect(wideEnough.panelVisible).toBe(true);
	});

	it("suppresses the toggle hint when the panel is requested-open but yielded at narrow width", () => {
		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		forceTerminalSize(mode, 64, 24);

		const arrival = mode.captureIrcArrivalSnapshot();
		expect(arrival.panelVisible).toBe(false);
		expect(arrival.panelRequestedVisible).toBe(true);

		const record = mode.ircLedger.observe(
			{
				observationId: "yielded-panel-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "no misleading hint",
				timestamp: 1,
			},
			arrival.panelVisible,
		);
		if (!record) throw new Error("Expected yielded-panel observation to be retained");
		expect(record.mode).toBe("persistent");

		const components = mode.addLiveIrcObservationToChat(
			{
				observationId: "yielded-panel-arrival",
				kind: "incoming",
				from: "worker",
				to: "you",
				text: "no misleading hint",
				timestamp: 1,
			},
			arrival,
		);
		const rendered = components.flatMap(component => component.render(120)).map(line => Bun.stripANSI(line));
		expect(rendered.join("\n")).not.toContain("opens sidebar");
	});

	it("marks only durable transcript messages as viewport-anchor eligible", async () => {
		await mode.init();
		mode.addMessageToChat({ role: "user", content: "durable semantic user", timestamp: 1 });
		mode.addMessageToChat({ role: "user", content: "synthetic replay row", synthetic: true, timestamp: 2 });
		mode.showStatus("ephemeral status row");

		const rendered = mode.chatContainer.renderWithViewportAnchors(48);
		const plainLines = rendered.lines.map(line => Bun.stripANSI(line));
		const durableRow = plainLines.findIndex(line => line.includes("durable semantic user"));
		const syntheticRow = plainLines.findIndex(line => line.includes("synthetic replay row"));
		const statusRow = plainLines.findIndex(line => line.includes("ephemeral status row"));
		expect(durableRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[durableRow]).not.toBeNull();
		const durableId = rendered.anchors[durableRow]?.id;
		expect(durableId).toBeDefined();
		const replayLabelRow = plainLines.findIndex(line => line.trim() === `${theme.rail.user} replay`);
		expect(replayLabelRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[replayLabelRow]).toBeNull();
		expect(rendered.lines.join("")).toContain("\x1b]133;A\x07");
		expect(rendered.lines.join("")).toContain("\x1b]133;B\x07\x1b]133;C\x07");
		expect(syntheticRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[syntheticRow]).toBeNull();
		expect(statusRow).toBeGreaterThanOrEqual(0);
		expect(rendered.anchors[statusRow]).toBeNull();

		mode.settings.set("irc.enabled", true);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(true);
		mode.toggleIrcSidebar();
		const visibleSplit = mode.ui.renderWithViewportAnchors(80);
		const visibleDurable = visibleSplit.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(visibleDurable).toBeGreaterThanOrEqual(0);
		expect(visibleSplit.anchors[visibleDurable]).not.toBeNull();

		mode.applyIrcSidebarAvailability(false);
		const temporarilyUnavailable = mode.ui.renderWithViewportAnchors(80);
		const temporaryRow = temporarilyUnavailable.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(temporaryRow).toBeGreaterThanOrEqual(0);
		expect(temporarilyUnavailable.anchors[temporaryRow]).not.toBeNull();
		mode.applyIrcSidebarAvailability(true);
		const restoredVisible = mode.ui.renderWithViewportAnchors(80);
		const restoredRow = restoredVisible.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(restoredRow).toBeGreaterThanOrEqual(0);
		expect(restoredVisible.anchors[restoredRow]).not.toBeNull();

		mode.settings.set("irc.sidebar.enabled", false);
		mode.applyIrcSidebarAvailability(false);
		const hiddenSplit = mode.ui.renderWithViewportAnchors(80);
		const hiddenDurable = hiddenSplit.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(hiddenDurable).toBeGreaterThanOrEqual(0);
		expect(hiddenSplit.anchors[hiddenDurable]).not.toBeNull();

		mode.settings.set("irc.enabled", false);
		mode.settings.set("irc.sidebar.enabled", true);
		mode.applyIrcSidebarAvailability(false);
		const unavailable = mode.ui.renderWithViewportAnchors(80);
		const unavailableRow = unavailable.anchors.findIndex(anchor => anchor?.id === durableId);
		expect(unavailableRow).toBeGreaterThanOrEqual(0);
		expect(unavailable.anchors[unavailableRow]).not.toBeNull();
	});

	it("keeps duplicate transcript occurrences distinct and stable across rebuild", () => {
		const userMessages = [
			{ role: "user" as const, content: "identical user", timestamp: 42 },
			{ role: "user" as const, content: "identical user", timestamp: 42 },
		];
		const assistantMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "identical assistant" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "same-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 42,
		});
		const assistantMessages = [assistantMessage(), assistantMessage()];
		associateSessionMessageEntryId(userMessages[0], "user-a");
		associateSessionMessageEntryId(userMessages[1], "user-b");
		associateSessionMessageEntryId(assistantMessages[0], "assistant-a");
		associateSessionMessageEntryId(assistantMessages[1], "assistant-b");
		for (const message of [...userMessages, ...assistantMessages]) mode.addMessageToChat(message);
		const orderedOccurrenceIds = (anchors: ReadonlyArray<{ id: string } | null>, prefix: string): string[] => {
			const ids: string[] = [];
			const seen = new Set<string>();
			for (const anchor of anchors) {
				if (anchor === null || !anchor.id.startsWith(prefix) || seen.has(anchor.id)) continue;
				seen.add(anchor.id);
				ids.push(anchor.id);
			}
			return ids;
		};
		const initial = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		const initialUserIds = orderedOccurrenceIds(initial, "user:");
		const initialAssistantIds = orderedOccurrenceIds(initial, "assistant:");
		expect(initialUserIds).toHaveLength(2);
		expect(initialAssistantIds).toHaveLength(2);

		mode.chatContainer.clear();
		const insertedUser = { ...userMessages[0] };
		const rebuiltUserA = { ...userMessages[0] };
		const rebuiltUserB = { ...userMessages[1] };
		const rebuiltAssistantA = assistantMessage();
		const rebuiltAssistantB = assistantMessage();
		associateSessionMessageEntryId(insertedUser, "user-inserted");
		associateSessionMessageEntryId(rebuiltUserA, "user-a");
		associateSessionMessageEntryId(rebuiltUserB, "user-b");
		associateSessionMessageEntryId(rebuiltAssistantA, "assistant-a");
		associateSessionMessageEntryId(rebuiltAssistantB, "assistant-b");
		mode.renderSessionContext({
			messages: [insertedUser, rebuiltUserA, rebuiltUserB, rebuiltAssistantA, rebuiltAssistantB],
		} as unknown as SessionContext);
		const inserted = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		expect(orderedOccurrenceIds(inserted, "user:")).toEqual(["user:entry:user-inserted", ...initialUserIds]);
		expect(orderedOccurrenceIds(inserted, "assistant:")).toEqual(initialAssistantIds);

		mode.chatContainer.clear();
		mode.renderSessionContext({
			messages: [rebuiltUserA, rebuiltUserB, rebuiltAssistantA, rebuiltAssistantB],
		} as unknown as SessionContext);
		const afterDeletion = mode.chatContainer.renderWithViewportAnchors(80).anchors;
		expect(orderedOccurrenceIds(afterDeletion, "user:")).toEqual(initialUserIds);
		expect(orderedOccurrenceIds(afterDeletion, "assistant:")).toEqual(initialAssistantIds);
	});

	it("preserves a live assistant anchor ID after persistence and transcript rebuild", () => {
		const liveMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "live then persisted" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "same-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 77,
		};
		const liveId = mode.getAssistantViewportAnchorId(liveMessage);
		expect(liveId).toContain(":occurrence:");
		mode.addMessageToChat(liveMessage);
		expect(
			mode.chatContainer
				.renderWithViewportAnchors(80)
				.anchors.some(anchor => anchor?.id === `${liveId}:content:0:text`),
		).toBe(true);

		session.sessionManager.appendMessage(liveMessage);
		const rebuiltContext = session.sessionManager.buildSessionContext();
		const rebuiltMessage = rebuiltContext.messages.find(message => message.role === "assistant");
		if (rebuiltMessage?.role !== "assistant") throw new Error("Expected rebuilt assistant message");
		expect(rebuiltMessage).not.toBe(liveMessage);
		expect(mode.getAssistantViewportAnchorId(rebuiltMessage)).toBe(liveId);

		mode.chatContainer.clear();
		mode.renderSessionContext(rebuiltContext);
		expect(
			mode.chatContainer
				.renderWithViewportAnchors(80)
				.anchors.some(anchor => anchor?.id === `${liveId}:content:0:text`),
		).toBe(true);
	});
	function expectedNewlineShortcutHint(): string {
		const newlineKeys =
			injectedKeyDisplayContext.platform === "win32" ? ["alt+enter", "ctrl+j"] : ["shift+enter", "ctrl+j"];
		return `${formatKeyHints(newlineKeys, injectedKeyDisplayContext)}: New line`;
	}

	it("keeps the rail composer inside its trailing gutter for CJK input", () => {
		mode.editor.focused = true;
		mode.editor.setText("이전 커밋들");

		const lines = mode.editor.render(48).map(stripRenderControls);
		const promptLine = lines.find(line => line.includes("이전 커밋들"));

		expect(promptLine).toBeDefined();
		expect(lines.every(line => visibleWidth(line) === 48)).toBe(true);
		expect(lines.every(line => line.endsWith(" "))).toBe(true);
		expect(promptLine!).toStartWith(`${theme.rail.user} `);
		expect(promptLine!).toContain("이전 커밋들");
	});

	function expectedQueueShortcutHint(action = "Queue"): string {
		const shortcut = mode.keybindings.getKeys("app.message.queue")[0];
		if (!shortcut) throw new Error("Expected a queue message keybinding");
		return `${formatKeyHint(shortcut, injectedKeyDisplayContext)}: ${action}`;
	}
	function expectedSubmitShortcutHint(action = "Steer"): string {
		const shortcut = mode.keybindings.getDisplayString("tui.input.submit", injectedKeyDisplayContext);
		if (!shortcut) throw new Error("Expected a submit keybinding");
		return `${shortcut}: ${action}`;
	}

	it("keeps common shortcut discovery in the composer and shows actionable busy delivery hints", () => {
		let rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedNewlineShortcutHint());
		expect(rendered).toContain(`${formatKeyHint("ctrl+c", injectedKeyDisplayContext)}: Clear`);
		expect(rendered).toContain(`${formatKeyHint("ctrl+r", injectedKeyDisplayContext)}: History`);
		expect(rendered).toContain(`${formatKeyHint("shift+tab", injectedKeyDisplayContext)}: Thinking`);
		expect(rendered).not.toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint("Queue (busy)"));
		const narrowRendered = mode.editor.render(80).map(stripRenderControls).join("\n");
		expect(narrowRendered).toContain(expectedQueueShortcutHint("Queue (busy)"));

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint());

		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = false;
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).toContain("Type your message...");
		expect(rendered).not.toContain(expectedSubmitShortcutHint());
		expect(rendered).toContain(expectedQueueShortcutHint("Queue (busy)"));
	});
	it("uses the effective submit binding in busy hints and omits it when unbound", () => {
		(session.agent as unknown as { state: { isStreaming: boolean } }).state.isStreaming = true;
		mode.keybindings.setUserBindings({ "tui.input.submit": "ctrl+enter" });
		mode.updateEditorChrome();

		let rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		const remappedSubmit = mode.keybindings.getDisplayString("tui.input.submit", injectedKeyDisplayContext);
		expect(rendered).toContain(`${remappedSubmit}: Steer`);
		expect(rendered).toContain(expectedQueueShortcutHint());

		mode.keybindings.setUserBindings({
			"tui.input.submit": [],
			"app.message.queue": [],
			"app.message.followUp": [],
		});
		mode.updateEditorChrome();

		rendered = mode.editor.render(300).map(stripRenderControls).join("\n");
		expect(rendered).not.toContain(": Steer");
		expect(rendered).toContain(`${formatKeyHint("shift+tab", injectedKeyDisplayContext)}: Thinking`);
		expect(rendered).not.toContain(": Queue");
		expect(rendered).toContain("Type your message...");
	});
	it("propagates the injected non-host key display context to the composed TUI surfaces", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, 160, 40);
		await mode.init();

		const composer = mode.editor.render(300).map(stripRenderControls).join("\n");
		const welcome = mode.ui.render(160).map(stripRenderControls).join("\n");
		expect(composer).toContain(expectedNewlineShortcutHint());
		expect(composer).toContain(mode.keybindings.getDisplayString("app.model.select", injectedKeyDisplayContext));
		expect(welcome).toContain(`${formatKeyHint("ctrl+l", injectedKeyDisplayContext)} ${t("welcome.model")}`);

		mode.statusLine.setActionRegistry(
			{
				all: () => [{ id: "app.model.select", title: "Select model", domains: ["composer"] }],
				isAvailable: () => true,
			} as never,
			() => mode.keybindings,
		);
		const status = mode.statusLine.render(500).map(stripRenderControls).join("\n");
		expect(status).not.toContain(mode.keybindings.getDisplayString("app.model.select", injectedKeyDisplayContext));
	});

	it("renders the composer directly below the status line without hook widgets", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});

		await mode.init();

		const assertComposerFollowsStatusLine = () => {
			const rendered = mode.ui.render(48).map(stripRenderControls);
			// The rail composer has no top border: its first row is the input row.
			const composerIndex = rendered.findIndex(line => line.includes("Type your message..."));
			const statusRows = mode.statusLine.render(48).map(stripRenderControls);

			expect(composerIndex).toBeGreaterThan(0);
			expect(rendered.slice(composerIndex - statusRows.length, composerIndex)).toEqual(statusRows);
		};

		assertComposerFollowsStatusLine();

		mode.setHookWidget("test", ["temporary widget"]);
		mode.setHookWidget("test", undefined);

		assertComposerFollowsStatusLine();
	});

	it("keeps the welcome splash viewport-bound when /new shows a notification", async () => {
		const width = 100;
		const rows = 28;
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, width, rows);

		await mode.init();

		mode.chatContainer.clear();
		mode.chatContainer.addChild(
			new Text(`${theme.fg("accent", `${theme.status.success} New session started`)}`, 1, 0),
		);

		const rendered = mode.ui.render(width).map(stripRenderControls);
		const renderedText = rendered.join("\n");
		const noticeIndex = rendered.findIndex(line => line.includes("New session started"));
		expect(rendered.length).toBeLessThanOrEqual(rows);
		expect(renderedText).toContain("╔═╗╔═╗");
		// The card gives up rows to the notice instead of pushing it off screen.
		expect(noticeIndex).toBeGreaterThan(rendered.findIndex(line => line.includes("╔═╗╔═╗")));
		expect(renderedText).toContain("New session started");
	});

	it("keeps the rail on every composer row for one-line, multiline, and narrow prompts", () => {
		for (const [width, text] of [
			[48, "Ask skc to improve the composer"],
			[48, "first line\nsecond line"],
			[28, "narrow terminal composer"],
		] as const) {
			mode.editor.setText(text);
			const lines = mode.editor.render(width).map(stripRenderControls);

			expect(lines.every(line => visibleWidth(line) === width)).toBe(true);
			expect(lines.every(line => line.endsWith(" "))).toBe(true);
			expect(lines.every(line => line.startsWith(`${theme.rail.user} `))).toBe(true);
			expect(lines.length).toBeGreaterThanOrEqual(text.includes("\n") ? 2 : 1);
			expect(lines.join("\n")).not.toContain("╭");
			expect(lines.join("\n")).not.toContain("Type your message...");
		}
	});

	it("keeps the focused composer visible at constrained terminal height", async () => {
		vi.spyOn(mode.ui, "start").mockImplementation(() => {});
		forceTerminalSize(mode, 48, 3);
		await mode.init();
		mode.editor.focused = true;
		mode.editor.setText("keep this focused draft visible");

		const rendered = mode.ui.render(48).map(stripRenderControls);
		expect(rendered.join("\n")).toContain("keep this focused draft visible");
		expect(
			rendered.some(line => line.startsWith(`${theme.rail.user} `) && line.includes("keep this focused draft")),
		).toBe(true);
	});

	it("labels shell modes on the rail and colors the rail by mode", () => {
		mode.editor.setText("!!pwd");
		mode.isBashMode = true;
		mode.isBashNoContext = true;

		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.fg("warning", "x"));
		let lines = mode.editor.render(48).map(stripRenderControls);
		expect(
			lines.some(line => line.startsWith(`${theme.rail.user} shell no-context `) && line.includes("!!pwd")),
		).toBe(true);

		mode.isBashNoContext = false;
		mode.updateEditorChrome();

		expect(mode.editor.borderColor("x")).toBe(theme.getBashModeBorderColor()("x"));
		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith(`${theme.rail.user} shell `) && line.includes("!!pwd"))).toBe(true);
		// The composer band comes first, then the rail in the mode color.
		expect(mode.editor.render(48)[0]).toStartWith(
			`${theme.getBgAnsi("userMessageBg")}${theme.getBashModeBorderColor()(`${theme.rail.user} `)}`,
		);

		mode.isBashMode = false;
		mode.updateEditorChrome();

		lines = mode.editor.render(48).map(stripRenderControls);
		expect(lines.some(line => line.startsWith(`${theme.rail.user} !!pwd`))).toBe(true);
		expect(lines.join("\n")).not.toContain("shell");
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("preserves a pending pet mode across editor replacement", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			setTerminalImageProtocol(null);
			settings.set("pet.mode", "red");
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("off");

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("off");

			expect(settings.get("pet.mode")).toBe("red");
			setTerminalImageProtocol(ImageProtocol.Sixel);
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.petWidget?.mode).toBe("red");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("disposes a pre-init pet widget before init replaces it", async () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			setTerminalImageProtocol(null);
			settings.set("pet.mode", "red");
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			const preInitWidget = mode.petWidget;
			if (!preInitWidget) throw new Error("Expected pre-init pet widget");
			const dispose = vi.spyOn(preInitWidget, "dispose");

			await mode.init();

			expect(dispose).toHaveBeenCalledTimes(1);
			expect(mode.petWidget).not.toBe(preInitWidget);
			expect(mode.petWidget?.mode).toBe("off");

			setTerminalImageProtocol(ImageProtocol.Sixel);
			expect(mode.petWidget?.mode).toBe("red");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	it("commits pet modes through the shared result-returning policy", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		try {
			settings.set("pet.mode", "off");
			const showStatus = vi.spyOn(mode, "showStatus").mockImplementation(() => {});

			// Capability is rechecked immediately before mutation: a rejected
			// commit surfaces the warning and never persists.
			setTerminalImageProtocol(null);
			expect(mode.setPetMode("red")).toBe(false);
			expect(settings.get("pet.mode")).toBe("off");
			expect(mode.petWidget?.mode ?? "off").toBe("off");
			expect(showStatus).toHaveBeenCalledTimes(1);

			expect(mode.commitPetPreviewMode("red")).toBe(false);
			expect(settings.get("pet.mode")).toBe("off");
			expect(showStatus).toHaveBeenCalledTimes(2);

			// An accepted commit persists only after the widget mutation applies.
			setTerminalImageProtocol(ImageProtocol.Sixel);
			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			expect(mode.setPetMode("red")).toBe(true);
			expect(settings.get("pet.mode")).toBe("red");
			expect(mode.commitPetPreviewMode("off")).toBe(true);
			expect(settings.get("pet.mode")).toBe("off");
		} finally {
			setTerminalImageProtocol(originalProtocol);
		}
	});

	describe("continue the most recent session", () => {
		const writeSession = (name: string, id: string, title: string, mtimeMs: number): string => {
			const file = path.join(tempDir.path(), `${name}.jsonl`);
			const records = [
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id,
					title,
					timestamp: "2026-01-01T00:00:00Z",
					cwd: tempDir.path(),
				},
				{
					type: "message",
					id: `${id}-m`,
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: title, timestamp: 1 },
				},
			];
			fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
			return file;
		};

		it("resumes the newest other session, idle-only", async () => {
			writeSession("older", "older-id", "older work", 1_000_000);
			const newest = writeSession("newest", "newest-id", "newest work", 2_000_000);
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);

			await mode.continueRecentSession();

			expect(resume).toHaveBeenCalledTimes(1);
			expect(fs.realpathSync(resume.mock.calls[0]?.[0] as string)).toBe(fs.realpathSync(newest));
			expect(resume.mock.calls[0]?.[1]).toEqual({ requireIdle: true });
		});

		it("never continues the live session into itself", async () => {
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			const live = session.sessionManager.getSessionFile()!;
			fs.mkdirSync(path.dirname(live), { recursive: true });
			const records = [
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: session.sessionManager.getSessionId(),
					timestamp: "2026-01-01T00:00:00Z",
					cwd: tempDir.path(),
				},
				{
					type: "message",
					id: "m",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					message: { role: "user", content: "live", timestamp: 1 },
				},
			];
			fs.writeFileSync(live, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			fs.utimesSync(live, new Date(3_000_000), new Date(3_000_000));
			const older = writeSession("older", "older-id", "older work", 1_000_000);

			await mode.continueRecentSession();

			expect(fs.realpathSync(resume.mock.calls[0]?.[0] as string)).toBe(fs.realpathSync(older));
		});

		it("says so instead of resuming when there is no earlier session", async () => {
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			const status = vi.spyOn(mode, "showStatus");

			await mode.continueRecentSession();

			expect(resume).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledWith("No earlier session to continue");
		});

		/** Start the UI on a silent terminal and return a function that feeds raw input through the TUI. */
		const startWithInput = async (): Promise<{ send: (data: string) => void; mouse: boolean[] }> => {
			let onInput: ((data: string) => void) | undefined;
			const mouse: boolean[] = [];
			const terminal = mode.ui.terminal as unknown as Record<string, unknown>;
			for (const method of [
				"write",
				"moveBy",
				"hideCursor",
				"showCursor",
				"clearLine",
				"clearFromCursor",
				"clearScreen",
				"setTitle",
				"setProgress",
			]) {
				vi.spyOn(terminal as never, method as never).mockImplementation((() => {}) as never);
			}
			vi.spyOn(terminal as never, "start" as never).mockImplementation(((handler: (data: string) => void) => {
				onInput = handler;
			}) as never);
			vi.spyOn(terminal as never, "stop" as never).mockImplementation((() => {}) as never);
			vi.spyOn(terminal as never, "setMouseEnabled" as never).mockImplementation(((enabled: boolean) => {
				mouse.push(enabled);
			}) as never);
			forceTerminalSize(mode, 120, 40);
			await mode.init();
			return { send: data => onInput!(data), mouse };
		};

		it("opens a card session with ↓ and Enter, and hands ↓ to history once the composer is busy", async () => {
			writeSession("older", "older-id", "older work", 1_000_000);
			const newest = writeSession("newest", "newest-id", "newest work", 2_000_000);
			const { send } = await startWithInput();
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			for (let i = 0; i < 40 && !mode.ui.render(120).some(line => line.includes("newest work")); i++)
				await Bun.sleep(5);

			send("\x1b[B"); // ↓ from the empty composer: first row highlighted
			send("\x1b[B"); // second row
			send("\x1b[A"); // back to the first
			send("\r");
			for (let i = 0; i < 20 && resume.mock.calls.length === 0; i++) await Bun.sleep(5);
			expect(resume).toHaveBeenCalledTimes(1);
			expect(fs.realpathSync(resume.mock.calls[0]?.[0] as string)).toBe(fs.realpathSync(newest));
			expect(resume.mock.calls[0]?.[1]).toEqual({ requireIdle: true });
			// Opening a session ends the card's interaction.
			send("\x1b[B");
			expect(mode.editor.getText()).toBe("");
		});

		it("moves one row per tap and opens with Enter under the kitty keyboard protocol (press + release events)", async () => {
			writeSession("oldest", "oldest-id", "oldest work", 1_000_000);
			writeSession("older", "older-id", "older work", 2_000_000);
			writeSession("newest", "newest-id", "newest work", 3_000_000);
			const { send } = await startWithInput();
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			for (let i = 0; i < 40 && !mode.ui.render(120).some(line => line.includes("oldest work")); i++)
				await Bun.sleep(5);
			setKittyProtocolActive(true);
			try {
				// Ghostty/kitty: a tap is a press and a release; the release must not cancel the pick.
				const tap = (press: string, release: string) => {
					send(press);
					send(release);
				};
				tap("\x1b[B", "\x1b[1;1:3B"); // ↓ → first row
				tap("\x1b[B", "\x1b[1;1:3B"); // ↓ → second row
				const highlighted = mode.ui
					.render(120)
					.map(stripRenderControls)
					.find(line => line.includes("›"));
				expect(highlighted).toContain("older work");
				tap("\r", "\x1b[13;1:3u"); // Enter
				for (let i = 0; i < 20 && resume.mock.calls.length === 0; i++) await Bun.sleep(5);
				expect(resume).toHaveBeenCalledTimes(1);
				expect(fs.realpathSync(resume.mock.calls[0]?.[0] as string)).toBe(
					fs.realpathSync(path.join(tempDir.path(), "older.jsonl")),
				);
			} finally {
				setKittyProtocolActive(false);
			}
		});

		it("leaves ↓ to the composer when it has text, and Esc returns to typing", async () => {
			writeSession("previous", "previous-id", "previous work", 2_000_000);
			const { send } = await startWithInput();
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			for (let i = 0; i < 40 && !mode.ui.render(120).some(line => line.includes("previous work")); i++)
				await Bun.sleep(5);

			send("\x1b[B");
			send("\x1b"); // Esc: back to the composer
			await Bun.sleep(60);
			send("h");
			expect(mode.editor.getText()).toBe("h");
			send("\x1b[B"); // composer busy: no highlight
			send("\r");
			await Bun.sleep(20);
			expect(resume).not.toHaveBeenCalled();
		});

		it("captures the mouse only until the first prompt, and opens a session on click", async () => {
			writeSession("previous", "previous-id", "previous work", 2_000_000);
			const { send, mouse } = await startWithInput();
			expect(mode.ui.mouseEnabled).toBe(true);
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);
			let lines: string[] = [];
			for (let i = 0; i < 40; i++) {
				lines = mode.ui.render(120).map(stripRenderControls);
				if (lines.some(line => line.includes("previous work"))) break;
				await Bun.sleep(5);
			}
			const row = lines.findIndex(line => line.includes("previous work"));
			expect(row).toBeGreaterThan(0);
			await Bun.sleep(20);
			send(`\x1b[<0;6;${row + 1}M`);
			for (let i = 0; i < 20 && resume.mock.calls.length === 0; i++) await Bun.sleep(5);
			expect(resume).toHaveBeenCalledTimes(1);
			// Opening the session gave the mouse back.
			expect(mode.ui.mouseEnabled).toBe(false);
			expect(mouse.at(-1)).toBe(false);
		});

		it("keeps the launch card text-only even when the composer pet is enabled", async () => {
			await startWithInput();
			const welcome = mode.ui.children.find(child => child instanceof WelcomeComponent) as WelcomeComponent;
			expect(welcome).toBeDefined();
			const lines = welcome.render(120).map(stripRenderControls);
			expect(lines[1]).toMatch(/^ {2}╔═╗╔═╗/);
			expect(lines.join("\n")).not.toContain(String.fromCodePoint(0x10eeee));
		});

		it("gives the mouse back when the first prompt is sent", async () => {
			const { mouse } = await startWithInput();
			expect(mode.ui.mouseEnabled).toBe(true);
			mode.endWelcomeInteraction();
			expect(mode.ui.mouseEnabled).toBe(false);
			expect(mouse).toContain(true);
			expect(mouse.at(-1)).toBe(false);
		});

		it("is bound to ctrl+q in the composer and named on the launch card", async () => {
			vi.spyOn(mode.ui, "start").mockImplementation(() => {});
			forceTerminalSize(mode, 120, 40);
			writeSession("previous", "previous-id", "previous work", 2_000_000);
			await mode.init();
			const resume = vi.spyOn(mode, "handleResumeSession").mockResolvedValue(true);

			expect(mode.keybindings.getKeys("app.session.continue")).toEqual(["ctrl+q"]);
			mode.editor.handleInput("\x11");
			for (let i = 0; i < 20 && resume.mock.calls.length === 0; i++) await Bun.sleep(5);
			expect(resume).toHaveBeenCalledTimes(1);

			// The card's session list loads after the first frame; wait for it instead of racing it.
			const hint = t("welcome.continue", { key: formatKeyHint("ctrl+q", injectedKeyDisplayContext) });
			let card = "";
			for (let i = 0; i < 100; i++) {
				card = mode.ui.render(120).map(stripRenderControls).join("\n");
				if (card.includes(hint)) break;
				await Bun.sleep(10);
			}
			expect(card).toContain(hint);
		});
	});
});
