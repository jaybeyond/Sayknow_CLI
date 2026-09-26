import { beforeAll, describe, expect, it, vi } from "bun:test";
import { UserMessageSelectorComponent } from "../src/modes/components/user-message-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";

beforeAll(async () => {
	await initTheme(false);
});

interface Harness {
	ctx: InteractiveModeContext;
	controller: SelectorController;
	calls: {
		error: ReturnType<typeof vi.fn>;
		warning: ReturnType<typeof vi.fn>;
		status: ReturnType<typeof vi.fn>;
		setText: ReturnType<typeof vi.fn>;
		rebuild: ReturnType<typeof vi.fn>;
		branch: ReturnType<typeof vi.fn>;
	};
	state: { sessionId: string; sessionFile: string | undefined };
	mounted(): UserMessageSelectorComponent | undefined;
}

function harness(options: {
	branch?: (entryId: string) => Promise<{ cancelled: boolean; selectedText: string }>;
	sessionFile?: string | undefined;
	isStreaming?: boolean;
	messages?: Array<{ entryId: string; text: string }>;
}): Harness {
	const state = {
		sessionId: "parent",
		sessionFile: "sessionFile" in options ? options.sessionFile : "/s/parent.jsonl",
	};
	const children: unknown[] = [];
	const editor = { setText: vi.fn() };
	const branch = vi.fn(
		options.branch ??
			(async () => {
				state.sessionId = "child";
				state.sessionFile = "/s/child.jsonl";
				return { cancelled: false, selectedText: "second prompt" };
			}),
	);
	const calls = {
		error: vi.fn(),
		warning: vi.fn(),
		status: vi.fn(),
		setText: editor.setText,
		rebuild: vi.fn(),
		branch,
	};
	const ctx = {
		session: {
			isStreaming: options.isStreaming ?? false,
			isCompacting: false,
			getUserMessagesForBranching: () =>
				options.messages ?? [
					{ entryId: "e1", text: "first prompt" },
					{ entryId: "e2", text: "second prompt" },
				],
			branch,
		},
		sessionManager: {
			getSessionId: () => state.sessionId,
			getSessionFile: () => state.sessionFile,
			getSessionName: () => undefined,
			getCwd: () => "/tmp/project",
		},
		bashComponent: undefined,
		pythonComponent: undefined,
		editor,
		editorContainer: {
			clear: () => {
				children.length = 0;
			},
			addChild: (child: unknown) => children.push(child),
		},
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), terminal: { rows: 40 } },
		statusLine: { invalidate: vi.fn(), setSessionStartTime: vi.fn() },
		showError: calls.error,
		showWarning: calls.warning,
		showStatus: calls.status,
		hasActiveBtw: () => false,
		handleBtwEscape: () => false,
		resetIrcSidebarSession: vi.fn(),
		resetObserverRegistry: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		rebuildInitialMessages: calls.rebuild,
		reloadTodos: vi.fn(async () => {}),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		controller: new SelectorController(ctx),
		calls,
		state,
		mounted: () =>
			children.find(child => child instanceof UserMessageSelectorComponent) as
				| UserMessageSelectorComponent
				| undefined,
	};
}

async function selectLatest(h: Harness): Promise<void> {
	h.controller.showUserMessageSelector();
	const selector = h.mounted();
	if (!selector) throw new Error("Expected the prompt selector to mount");
	selector.getMessageList().handleInput("\n");
	await Bun.sleep(0);
}

describe("/fork prompt selector", () => {
	it("forks from the selected prompt and restores it as an editable draft", async () => {
		const h = harness({});
		await selectLatest(h);

		expect(h.calls.branch).toHaveBeenCalledWith("e2");
		expect(h.calls.rebuild).toHaveBeenCalledWith("replace-identity");
		expect(h.calls.setText).toHaveBeenCalledWith("second prompt");
		expect(h.calls.status).toHaveBeenCalledWith("Forked to a new session; edit the selected prompt to continue");
		expect(h.calls.error).not.toHaveBeenCalled();
	});

	it("refuses to open for an unpersisted session or while a response is streaming", () => {
		const unpersisted = harness({ sessionFile: undefined });
		unpersisted.controller.showUserMessageSelector();
		expect(unpersisted.mounted()).toBeUndefined();
		expect(unpersisted.calls.error).toHaveBeenCalledWith("Fork requires a persisted session");

		const busy = harness({ isStreaming: true });
		busy.controller.showUserMessageSelector();
		expect(busy.mounted()).toBeUndefined();
		expect(busy.calls.warning.mock.calls[0]?.[0]).toContain("before forking");
	});

	it("says so when there is nothing to fork from", () => {
		const h = harness({ messages: [] });
		h.controller.showUserMessageSelector();
		expect(h.mounted()).toBeUndefined();
		expect(h.calls.status).toHaveBeenCalledWith("No messages to branch from");
	});

	it("ignores a second Enter while the first fork is in flight", async () => {
		const pending = Promise.withResolvers<{ cancelled: boolean; selectedText: string }>();
		const h = harness({ branch: () => pending.promise });
		h.controller.showUserMessageSelector();
		const list = h.mounted()!.getMessageList();
		list.handleInput("\n");
		list.handleInput("\n");
		pending.resolve({ cancelled: true, selectedText: "" });
		await Bun.sleep(0);
		expect(h.calls.branch).toHaveBeenCalledTimes(1);
		expect(h.calls.status).toHaveBeenCalledWith("Fork cancelled");
		expect(h.calls.setText).not.toHaveBeenCalled();
	});

	it("reports a failure before the child exists as a failed fork and keeps the parent", async () => {
		const h = harness({
			branch: async () => {
				throw new Error("disk full");
			},
		});
		await selectLatest(h);
		expect(h.calls.error).toHaveBeenCalledWith("Fork failed: disk full");
		expect(h.calls.rebuild).not.toHaveBeenCalled();
		expect(h.calls.setText).not.toHaveBeenCalled();
	});

	it("still moves to a committed child when setup after the commit throws", async () => {
		const h = harness({});
		h.calls.branch.mockImplementation(async () => {
			h.state.sessionId = "child";
			h.state.sessionFile = "/s/child.jsonl";
			throw new Error("mcp restore failed");
		});
		await selectLatest(h);
		expect(h.calls.rebuild).toHaveBeenCalledWith("replace-identity");
		expect(h.calls.setText).toHaveBeenCalledWith("second prompt");
		expect(h.calls.error).toHaveBeenCalledWith("Fork created, but session setup failed: mcp restore failed");
	});

	it("cancels instead of forking a different session than the one it opened on", async () => {
		const h = harness({});
		h.controller.showUserMessageSelector();
		h.state.sessionId = "switched";
		h.mounted()!.getMessageList().handleInput("\n");
		await Bun.sleep(0);
		expect(h.calls.branch).not.toHaveBeenCalled();
		expect(h.calls.error).toHaveBeenCalledWith("Fork cancelled because the active session changed");
	});

	it("fits the list to the terminal height", () => {
		const messages = Array.from({ length: 30 }, (_, index) => ({ id: `e${index}`, text: `prompt ${index}` }));
		let rows = 20;
		const selector = new UserMessageSelectorComponent(
			messages,
			() => {},
			() => {},
			() => rows,
		);
		expect(selector.render(80).length).toBeLessThanOrEqual(rows);
		rows = 60;
		const tall = selector.render(80).length;
		expect(tall).toBeLessThanOrEqual(rows);
		expect(tall).toBeGreaterThan(20);
	});
});
