import { describe, expect, test } from "bun:test";
import { renderPetHalfBlocks } from "../src/components/sayknow-pet";
import { type Component, TUI } from "../src/tui";

function fakeTerminal(mouseCalls: boolean[] = []) {
	let input: ((data: string) => void) | undefined;
	const terminal = {
		columns: 80,
		rows: 24,
		available: true,
		kittyProtocolActive: false,
		start(handler: (data: string) => void) {
			input = handler;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setMouseEnabled(enabled: boolean) {
			mouseCalls.push(enabled);
		},
	} as unknown as import("../src/terminal").Terminal;
	return { terminal, send: (data: string) => input!(data) };
}

describe("clicks on top-level children", () => {
	test("reach the child under the click with its local row, before the focused editor", async () => {
		const { terminal, send } = fakeTerminal();
		const tui = new TUI(terminal, undefined, { enableMouse: true });
		const clicks: Array<[number, number]> = [];
		const header: Component = { render: () => ["header"], invalidate: () => {} };
		const card: Component = {
			render: () => ["row 0", "row 1", "row 2"],
			invalidate: () => {},
			handleClick: (line, column) => {
				clicks.push([line, column]);
				return line === 1;
			},
		};
		const focusedClicks: unknown[] = [];
		const editor: Component = {
			render: () => ["> "],
			invalidate: () => {},
			handleInput: () => {},
			handleMouse: event => focusedClicks.push(event),
		};
		tui.addChild(header);
		tui.addChild(card);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await Bun.sleep(1);

		// Screen row 3 (1-based) is the card's line 1: consumed, the editor never sees it.
		send("\x1b[<0;5;3M");
		expect(clicks).toEqual([[1, 4]]);
		expect(focusedClicks).toEqual([]);

		// Card line 2 is not claimed: the click falls through to the focused component.
		send("\x1b[<0;2;4M");
		expect(clicks).toEqual([
			[1, 4],
			[2, 1],
		]);
		expect(focusedClicks).toHaveLength(1);

		// The header takes no clicks.
		send("\x1b[<0;1;1M");
		expect(clicks).toHaveLength(2);
		tui.stop();
	});

	test("mouse reporting can be switched at runtime", () => {
		const calls: boolean[] = [];
		const { terminal } = fakeTerminal(calls);
		const tui = new TUI(terminal);
		expect(tui.mouseEnabled).toBe(false);
		tui.start();
		tui.setMouseEnabled(true);
		tui.setMouseEnabled(true);
		expect(tui.mouseEnabled).toBe(true);
		tui.setMouseEnabled(false);
		expect(calls).toEqual([false, true, false]);
		tui.stop();
	});
});

describe("small pet", () => {
	test("draws the octopus in 8 columns and 4 rows for every intro pose", () => {
		for (const frame of ["base", "danceL", "danceR"] as const) {
			const lines = renderPetHalfBlocks(frame, "red", "truecolor", { scale: "half" });
			expect(lines).toHaveLength(4);
			for (const line of lines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBe(8);
		}
		// Eye white and pupil are both present.
		const base = renderPetHalfBlocks("base", "red", "truecolor", { scale: "half" }).join("");
		expect(base).toContain("240;244;250");
		expect(base).toContain("24;18;16");
		// A pose without small art falls back to the base.
		expect(renderPetHalfBlocks("cry1", "red", "truecolor", { scale: "half" })).toEqual(
			renderPetHalfBlocks("base", "red", "truecolor", { scale: "half" }),
		);
	});
});
