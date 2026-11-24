import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/config/keybindings";
import { getLanguage, setLanguage } from "../src/i18n";
import {
	getComposerActions,
	getComposerPlaceholder,
	getDefaultComposerPlaceholder,
} from "../src/modes/interactive-mode";

// Assertions read English labels; a non-English system locale must not leak in.
const originalLanguage = getLanguage();
beforeAll(() => setLanguage("en"));
afterAll(() => setLanguage(originalLanguage));

describe("composer placeholder", () => {
	it.each([
		["darwin", "⇧↩/⌃J New line"],
		["win32", "Alt+Enter/Ctrl+J New line"],
		["linux", "Shift+Enter/Ctrl+J New line"],
	] as const)("formats the idle newline hint for %s independently of the host", (platform, expected) => {
		expect(getDefaultComposerPlaceholder({ platform })).toBe(`Type your message · ${expected}`);
	});

	it("leaves model, thinking, history and queue keys to the keymap while idle", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.history.search": "alt+h",
			"app.thinking.cycle": "ctrl+t",
			"app.model.select": "super+m",
			"app.message.queue": "ctrl+k",
		});
		expect(
			getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: false, busyPromptMode: "steer" }),
		).toBe("Type your message · ⇧↩/⌃J New line");
	});

	it("names what Enter does and the queue key while busy in steer mode", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "alt+q",
			"tui.input.submit": "enter",
		});

		expect(getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: true, busyPromptMode: "steer" })).toBe(
			"Type your message · ↩ Steer · ⌥Q Queue · ⇧↩/⌃J New line",
		);
	});

	it("does not duplicate Queue when submit queues in busy queue mode", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "ctrl+k",
			"tui.input.submit": "enter",
		});

		expect(getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: true, busyPromptMode: "queue" })).toBe(
			"Type your message · ↩ Queue · ⇧↩/⌃J New line",
		);
	});

	it("falls back to the dedicated queue binding when busy queue submit is unbound", () => {
		const keybindings = KeybindingsManager.inMemory({
			"app.message.queue": "ctrl+k",
			"tui.input.submit": [],
		});

		expect(getComposerPlaceholder(keybindings, { platform: "win32" }, { busy: true, busyPromptMode: "queue" })).toBe(
			"Type your message · Ctrl+K Queue · Alt+Enter/Ctrl+J New line",
		);
	});

	it("follows the interface language", () => {
		setLanguage("ko");
		try {
			expect(getDefaultComposerPlaceholder({ platform: "darwin" })).toBe("메시지 입력 · ⇧↩/⌃J 줄바꿈");
			const keybindings = KeybindingsManager.inMemory({ "tui.input.submit": "enter" });
			expect(
				getComposerActions(keybindings, { platform: "darwin" }, { busy: false, busyPromptMode: "steer" }).map(
					action => action.label,
				),
			).toEqual(["@ 첨부", "↩ 보내기"]);
		} finally {
			setLanguage("en");
		}
	});
});

describe("composer actions", () => {
	const keybindings = KeybindingsManager.inMemory({ "tui.input.submit": "enter" });
	const labels = (busy: boolean, busyPromptMode: "steer" | "queue", platform: NodeJS.Platform = "darwin") =>
		getComposerActions(keybindings, { platform }, { busy, busyPromptMode }).map(action => action.label);

	it("names what the submit key does now, with that key", () => {
		expect(labels(false, "steer")).toEqual(["@ Attach", "↩ Send"]);
		expect(labels(true, "steer")).toEqual(["@ Attach", "↩ Steer"]);
		expect(labels(true, "queue")).toEqual(["@ Attach", "↩ Queue"]);
		expect(labels(false, "steer", "linux")).toEqual(["@ Attach", "Enter Send"]);
	});

	it("marks only the submit action as primary", () => {
		const actions = getComposerActions(keybindings, { platform: "darwin" }, { busy: false, busyPromptMode: "steer" });
		expect(actions.filter(action => action.primary).map(action => action.label)).toEqual(["↩ Send"]);
	});

	it("drops the key when submit is unbound", () => {
		const unbound = KeybindingsManager.inMemory({ "tui.input.submit": [] });
		const actions = getComposerActions(unbound, { platform: "darwin" }, { busy: false, busyPromptMode: "steer" });
		expect(actions.map(action => action.label)).toEqual(["@ Attach", "Send"]);
	});
});
