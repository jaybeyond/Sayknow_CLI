import { describe, expect, test } from "bun:test";
import { TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("TUI terminal reply filtering", () => {
	test("keeps late or duplicate probe replies away from the focused component", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const inputs: string[] = [];
		tui.setFocus({ render: () => [], invalidate: () => {}, handleInput: data => inputs.push(data) });
		tui.start();

		for (const reply of [
			"\x1b[?62;4;9;22c", // DA1
			"\x1b[?1;2c", // DA1 (tmux / xterm.js)
			"\x1b[?2;0;800;480S", // XTSMGRAPHICS
			"\x1b[?997;1n", // Mode 2031
			"\x1b[?7u", // kitty keyboard flags
			"\x1b[?2026;2$y", // DECRPM
			"\x1b]11;rgb:0f0f/1111/1010\x1b\\", // OSC 11, ST-terminated
			"\x1b]10;rgb:ffff/ffff/ffff\x07", // OSC 10, BEL-terminated
			"\x1b_Gi=31;OK\x1b\\", // kitty graphics
		]) {
			terminal.sendInput(reply);
		}

		// Keys that share a prefix with those replies still arrive.
		for (const key of ["a", "\x1b]", "\x1b_", "\x1bP", "\x1b[A", "\x1b[200~", "\x1b[97;5u", "\x1b[I"]) {
			terminal.sendInput(key);
		}

		expect(inputs).toEqual(["a", "\x1b]", "\x1b_", "\x1bP", "\x1b[A", "\x1b[200~", "\x1b[97;5u", "\x1b[I"]);
		tui.stop();
	});
});
