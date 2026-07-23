import { afterEach, describe, expect, it } from "bun:test";
import {
	ImageProtocol,
	isSixelMultiplexerEnabled,
	isUnderTerminalMultiplexer,
	isUnderTmux,
	onImageProtocolChanged,
	setTerminalImageProtocol,
	shouldProbeSixelCapability,
	TERMINAL,
	TUI,
	wrapTmuxPassthrough,
} from "@sayknow-cli/tui";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalWtSession = Bun.env.WT_SESSION;
const originalTmux = Bun.env.TMUX;
const originalTerm = Bun.env.TERM;
const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreIsTty(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}
	delete (stream as unknown as { isTTY?: boolean }).isTTY;
}

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
}

function probeSetup(): void {
	setTerminalImageProtocol(null);
	terminalInfo.imageProtocol = null;
	delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
}

describe("TUI SIXEL capability probe", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		restoreEnv("WT_SESSION", originalWtSession);
		restoreEnv("TMUX", originalTmux);
		restoreEnv("TERM", originalTerm);
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForceProtocol);
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("enables SIXEL only after positive terminal capability response", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA and graphics replies are coalesced in one chunk", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when DA reply arrives split across chunks", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;");
		terminal.sendInput("4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL on an XTSMGRAPHICS success reply (Ps=0)", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled when capability responses are negative", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// Real error replies: DA1 without the sixel attribute, then an
		// XTSMGRAPHICS failure (Ps=3, tmux's answer to an unsupported read).
		terminal.sendInput("\x1b[?1;2c");
		terminal.sendInput("\x1b[?2;3;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("does not read a DA1 device class of 4 as the sixel attribute", () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// `CSI ?4;6c` identifies a VT132 (leading device class 4); it does not
		// advertise the VT2xx+ sixel extension attribute.
		terminal.sendInput("\x1b[?4;6c");
		terminal.sendInput("\x1b[?2;3;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("probes under tmux and trusts the outer terminal's sixel DA1 via passthrough", () => {
		probeSetup();
		delete Bun.env.WT_SESSION;
		delete Bun.env.SKC_SIXEL_MULTIPLEXER;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// The query is passthrough-wrapped to the outer terminal, so its DA1 ";4"
		// sixel attribute is genuine end-to-end evidence — sixel is enabled.
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("stays off under tmux when the SKC_SIXEL_MULTIPLEXER kill-switch is set", () => {
		probeSetup();
		delete Bun.env.WT_SESSION;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		Bun.env.SKC_SIXEL_MULTIPLEXER = "0";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
		delete Bun.env.SKC_SIXEL_MULTIPLEXER;
	});

	it("does not probe when PI_FORCE_IMAGE_PROTOCOL is explicitly off", () => {
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput("\x1b[?1;2;4c");
		terminal.sendInput("\x1b[?2;0;800;480S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("times out without enabling SIXEL when a reply stays fragmented", async () => {
		if (process.platform !== "win32") return;
		probeSetup();
		Bun.env.WT_SESSION = "test-wt-session";
		delete Bun.env.TMUX;

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		// The DA1 terminator never arrives; the 250ms one-shot probe must give
		// up without enabling sixel.
		terminal.sendInput("\x1b[?62");
		await new Promise(resolve => setTimeout(resolve, 300));

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});
});

describe("shouldProbeSixelCapability", () => {
	afterEach(() => {
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForceProtocol);
	});

	it("probes only Windows Terminal on win32", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(true);
		expect(shouldProbeSixelCapability({ TERM: "xterm-256color" }, "win32")).toBe(false);
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "darwin")).toBe(false);
		expect(shouldProbeSixelCapability({ TERM: "xterm-256color" }, "linux")).toBe(false);
	});

	it("probes under tmux via passthrough, but not screen/zellij", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		// tmux forwards the passthrough-wrapped probe to the outer terminal.
		expect(shouldProbeSixelCapability({ TMUX: "/tmp/t,1,0" }, "linux")).toBe(true);
		expect(shouldProbeSixelCapability({ TERM: "tmux-256color" }, "linux")).toBe(true);
		expect(shouldProbeSixelCapability({ SKC_TMUX_LAUNCHED: "1" }, "linux")).toBe(true);
		// screen/zellij have no DCS passthrough envelope → graphics stay off.
		expect(shouldProbeSixelCapability({ STY: "1234.pts-0.host" }, "linux")).toBe(false);
		expect(shouldProbeSixelCapability({ ZELLIJ: "session" }, "linux")).toBe(false);
		expect(shouldProbeSixelCapability({ TERM: "screen-256color" }, "linux")).toBe(false);
	});

	it("respects the SKC_SIXEL_MULTIPLEXER kill-switch under tmux", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeSixelCapability({ TMUX: "/tmp/t,1,0", SKC_SIXEL_MULTIPLEXER: "0" }, "linux")).toBe(false);
		expect(shouldProbeSixelCapability({ TMUX: "/tmp/t,1,0", SKC_SIXEL_MULTIPLEXER: "off" }, "linux")).toBe(false);
		expect(shouldProbeSixelCapability({ TMUX: "/tmp/t,1,0", SKC_SIXEL_MULTIPLEXER: "1" }, "linux")).toBe(true);
	});

	it("treats an explicit PI_FORCE_IMAGE_PROTOCOL as authoritative", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(false);
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		expect(shouldProbeSixelCapability({ WT_SESSION: "s", TERM: "xterm-256color" }, "win32")).toBe(false);
	});
});

describe("isUnderTerminalMultiplexer", () => {
	it("detects tmux, screen, zellij, and SKC-launched panes", () => {
		expect(isUnderTerminalMultiplexer({ TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TMUX_PANE: "%3" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ STY: "1234.pts-0.host" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ ZELLIJ: "0" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ ZELLIJ: "session" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ SKC_TMUX_LAUNCHED: "1" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ SKC_TMUX_LAUNCHED: "0" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ TERM: "tmux-256color" })).toBe(true);
		expect(isUnderTerminalMultiplexer({ TERM: "screen-256color" })).toBe(true);
	});

	it("stays false for plain terminals", () => {
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-256color" })).toBe(false);
		expect(isUnderTerminalMultiplexer({ TERM: "xterm-kitty" })).toBe(false);
		expect(isUnderTerminalMultiplexer({})).toBe(false);
	});
});

describe("onImageProtocolChanged", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
	});

	it("fires on actual changes, dedupes same-value sets, and unsubscribes", () => {
		terminalInfo.imageProtocol = null;
		const seen: Array<ImageProtocol | null> = [];
		const unsubscribe = onImageProtocolChanged(protocol => {
			seen.push(protocol);
		});

		setTerminalImageProtocol(ImageProtocol.Sixel);
		setTerminalImageProtocol(ImageProtocol.Sixel);
		expect(seen).toEqual([ImageProtocol.Sixel]);

		setTerminalImageProtocol(null);
		expect(seen).toEqual([ImageProtocol.Sixel, null]);

		unsubscribe();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		expect(seen).toEqual([ImageProtocol.Sixel, null]);
	});
});

describe("tmux passthrough helpers", () => {
	it("isUnderTmux detects tmux only, not screen/zellij", () => {
		expect(isUnderTmux({ TMUX: "/tmp/t,1,0" })).toBe(true);
		expect(isUnderTmux({ TMUX_PANE: "%3" })).toBe(true);
		expect(isUnderTmux({ SKC_TMUX_LAUNCHED: "1" })).toBe(true);
		expect(isUnderTmux({ TERM: "tmux-256color" })).toBe(true);
		expect(isUnderTmux({ STY: "1234.pts-0.host" })).toBe(false);
		expect(isUnderTmux({ ZELLIJ: "session" })).toBe(false);
		expect(isUnderTmux({ TERM: "screen-256color" })).toBe(false);
		expect(isUnderTmux({ TERM: "xterm-256color" })).toBe(false);
	});

	it("isSixelMultiplexerEnabled defaults on and honors the kill-switch", () => {
		expect(isSixelMultiplexerEnabled({})).toBe(true);
		expect(isSixelMultiplexerEnabled({ SKC_SIXEL_MULTIPLEXER: "1" })).toBe(true);
		expect(isSixelMultiplexerEnabled({ SKC_SIXEL_MULTIPLEXER: "0" })).toBe(false);
		expect(isSixelMultiplexerEnabled({ SKC_SIXEL_MULTIPLEXER: "off" })).toBe(false);
		expect(isSixelMultiplexerEnabled({ SKC_SIXEL_MULTIPLEXER: "false" })).toBe(false);
	});

	it("wrapTmuxPassthrough wraps + doubles ESC under tmux, no-ops otherwise", () => {
		const sixel = "\x1bPq#0;2;0;0;0#0~~@@\x1b\\";
		const wrapped = wrapTmuxPassthrough(sixel, { TMUX: "/tmp/t,1,0" });
		expect(wrapped.startsWith("\x1bPtmux;")).toBe(true);
		expect(wrapped.endsWith("\x1b\\")).toBe(true);
		// every inner ESC is doubled
		expect(wrapped).toBe(`\x1bPtmux;${sixel.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
		// not under tmux → identity
		expect(wrapTmuxPassthrough(sixel, { TERM: "xterm-256color" })).toBe(sixel);
		expect(wrapTmuxPassthrough(sixel, { ZELLIJ: "session" })).toBe(sixel);
		// empty payload is never wrapped
		expect(wrapTmuxPassthrough("", { TMUX: "/tmp/t,1,0" })).toBe("");
	});
});
