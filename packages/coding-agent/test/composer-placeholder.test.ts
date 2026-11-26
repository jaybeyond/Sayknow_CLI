import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "../src/config/keybindings";
import { getLanguage, setLanguage } from "../src/i18n";
import { getComposerPlaceholder, getDefaultComposerPlaceholder } from "../src/modes/interactive-mode";

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
			const keybindings = KeybindingsManager.inMemory({ "tui.input.submit": "enter", "app.message.queue": "alt+q" });
			expect(
				getComposerPlaceholder(keybindings, { platform: "darwin" }, { busy: true, busyPromptMode: "steer" }),
			).toBe("메시지 입력 · ↩ 방향 지시 · ⌥Q 대기열 · ⇧↩/⌃J 줄바꿈");
		} finally {
			setLanguage("en");
		}
	});
});
