import { afterEach, describe, expect, it } from "bun:test";
import {
	getOverlayImageProtocol,
	getTmuxOverlayImageProtocol,
	ImageProtocol,
	isKittyMultiplexerEnabled,
	KITTY_CAPABILITY_QUERY,
	KITTY_PROBE_IMAGE_ID,
	resetTmuxPaneOffsetCache,
	resetTmuxPanePassthroughRequest,
	setTerminalImageProtocol,
	setTmuxOverlayImageProtocol,
	shouldProbeKittyPassthrough,
	TERMINAL,
	TUI,
	tmuxPaneOffset,
	wrapTmuxPassthrough,
} from "@sayknow-cli/tui";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalTmux = Bun.env.TMUX;
const originalTmuxPane = Bun.env.TMUX_PANE;
const originalTmuxLaunched = Bun.env.SKC_TMUX_LAUNCHED;
const originalTerm = Bun.env.TERM;
const originalForceProtocol = Bun.env.SKC_FORCE_IMAGE_PROTOCOL;
const originalPiForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalKittyMultiplexer = Bun.env.SKC_KITTY_MULTIPLEXER;
const originalTmuxCommand = Bun.env.SKC_TMUX_COMMAND;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

const OK_REPLY = `\x1b_Gi=${KITTY_PROBE_IMAGE_ID};OK\x1b\\`;

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
	setTmuxOverlayImageProtocol(null);
	terminalInfo.imageProtocol = null;
	delete Bun.env.SKC_FORCE_IMAGE_PROTOCOL;
	delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	delete Bun.env.SKC_KITTY_MULTIPLEXER;
	Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
	// Never shell out to a real tmux from the probe's pane-option request.
	Bun.env.SKC_TMUX_COMMAND = "true";
	resetTmuxPanePassthroughRequest();
	resetTmuxPaneOffsetCache();
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
}

function restoreAll(): void {
	setTerminalImageProtocol(originalProtocol);
	setTmuxOverlayImageProtocol(null);
	terminalInfo.imageProtocol = originalProtocol;
	restoreEnv("TMUX", originalTmux);
	restoreEnv("TMUX_PANE", originalTmuxPane);
	restoreEnv("SKC_TMUX_LAUNCHED", originalTmuxLaunched);
	restoreEnv("TERM", originalTerm);
	restoreEnv("SKC_FORCE_IMAGE_PROTOCOL", originalForceProtocol);
	restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalPiForceProtocol);
	restoreEnv("SKC_KITTY_MULTIPLEXER", originalKittyMultiplexer);
	restoreEnv("SKC_TMUX_COMMAND", originalTmuxCommand);
	resetTmuxPanePassthroughRequest();
	resetTmuxPaneOffsetCache();
	restoreIsTty(process.stdin, stdinIsTtyDescriptor);
	restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
}

describe("shouldProbeKittyPassthrough", () => {
	afterEach(restoreAll);

	it("probes only under tmux, which is the only multiplexer with DCS passthrough", () => {
		delete Bun.env.SKC_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0" })).toBe(true);
		expect(shouldProbeKittyPassthrough({ TMUX_PANE: "%3" })).toBe(true);
		expect(shouldProbeKittyPassthrough({ TERM: "tmux-256color" })).toBe(true);
		expect(shouldProbeKittyPassthrough({ STY: "1234.pts-0.host" })).toBe(false);
		expect(shouldProbeKittyPassthrough({ ZELLIJ: "session" })).toBe(false);
		expect(shouldProbeKittyPassthrough({ TERM: "xterm-ghostty" })).toBe(false);
		expect(shouldProbeKittyPassthrough({})).toBe(false);
	});

	it("honors the SKC_KITTY_MULTIPLEXER kill-switch", () => {
		delete Bun.env.SKC_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0", SKC_KITTY_MULTIPLEXER: "0" })).toBe(false);
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0", SKC_KITTY_MULTIPLEXER: "off" })).toBe(false);
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0", SKC_KITTY_MULTIPLEXER: "1" })).toBe(true);
		expect(isKittyMultiplexerEnabled({})).toBe(true);
		expect(isKittyMultiplexerEnabled({ SKC_KITTY_MULTIPLEXER: "false" })).toBe(false);
	});

	it("treats an explicit forced protocol as authoritative", () => {
		Bun.env.SKC_FORCE_IMAGE_PROTOCOL = "off";
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0" })).toBe(false);
		Bun.env.SKC_FORCE_IMAGE_PROTOCOL = "kitty";
		expect(shouldProbeKittyPassthrough({ TMUX: "/tmp/t,1,0" })).toBe(false);
	});
});

describe("TUI kitty passthrough capability probe", () => {
	afterEach(restoreAll);

	it("sends the capability query wrapped in the tmux passthrough envelope", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();

		expect(terminal.getWriteLog()).toContain(wrapTmuxPassthrough(KITTY_CAPABILITY_QUERY, { TMUX: "x" }));
		tui.stop();
	});

	it("enables the overlay protocol on OK while inline graphics stay suppressed", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput(OK_REPLY);

		expect(getTmuxOverlayImageProtocol()).toBe(ImageProtocol.Kitty);
		expect(getOverlayImageProtocol()).toBe(ImageProtocol.Kitty);
		// Inline rendering keeps drawing at tmux's stale physical cursor, so it
		// stays off: only absolutely-positioned overlays use the passthrough.
		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("re-queries the outer terminal's cell size once the overlay is enabled", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.clearWriteLog();
		terminal.sendInput(OK_REPLY);

		expect(terminal.getWriteLog()).toContain(wrapTmuxPassthrough("\x1b[16t", { TMUX: "x" }));
		tui.stop();
	});

	it("consumes the reply instead of leaking it into the input stream", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const seen: string[] = [];
		tui.start();
		tui.addInputListener(data => {
			seen.push(data);
			return undefined;
		});
		terminal.sendInput(`${OK_REPLY}hi`);

		expect(seen.join("")).toBe("hi");
		tui.stop();
	});

	it("stays off when the terminal reports the protocol as unsupported", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput(`\x1b_Gi=${KITTY_PROBE_IMAGE_ID};ENOTSUPPORTED\x1b\\`);

		expect(getTmuxOverlayImageProtocol()).toBeNull();
		tui.stop();
	});

	it("ignores a graphics response for a different image id", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput(`\x1b_Gi=${KITTY_PROBE_IMAGE_ID + 1};OK\x1b\\`);

		expect(getTmuxOverlayImageProtocol()).toBeNull();
		tui.stop();
	});

	it("resolves a reply split across chunks", () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		terminal.sendInput(`\x1b_Gi=${KITTY_PROBE_IMAGE_ID};O`);
		expect(getTmuxOverlayImageProtocol()).toBeNull();
		terminal.sendInput("K\x1b\\");

		expect(getTmuxOverlayImageProtocol()).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("gives up when no reply arrives before the passthrough deadline", async () => {
		probeSetup();

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();
		await new Promise(resolve => setTimeout(resolve, 700));

		expect(getTmuxOverlayImageProtocol()).toBeNull();
		tui.stop();
	});

	it("does not probe outside tmux", () => {
		probeSetup();
		delete Bun.env.TMUX;
		delete Bun.env.TMUX_PANE;
		delete Bun.env.SKC_TMUX_LAUNCHED;
		Bun.env.TERM = "xterm-ghostty";

		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.start();

		expect(terminal.getWriteLog().some(chunk => chunk.includes("a=q"))).toBe(false);
		tui.stop();
	});
});

describe("tmuxPaneOffset", () => {
	afterEach(restoreAll);

	it("is the identity outside tmux", () => {
		resetTmuxPaneOffsetCache();
		expect(tmuxPaneOffset({ TERM: "xterm-ghostty" })).toEqual({ top: 0, left: 0 });
		expect(tmuxPaneOffset({ ZELLIJ: "session" })).toEqual({ top: 0, left: 0 });
	});

	it("falls back to the identity when tmux cannot answer", () => {
		resetTmuxPaneOffsetCache();
		expect(tmuxPaneOffset({ TMUX: "/tmp/t,1,0", SKC_TMUX_COMMAND: "false" })).toEqual({ top: 0, left: 0 });
	});

	it("reads the pane origin and the top status lines from tmux", () => {
		resetTmuxPaneOffsetCache();
		// `echo` stands in for tmux: display -p prints the format, so the stub
		// prints the same three fields the real client would substitute.
		const stub = `${import.meta.dir}/fixtures/tmux-pane-offset-stub.sh`;
		expect(tmuxPaneOffset({ TMUX: "/tmp/t,1,0", SKC_TMUX_COMMAND: stub })).toEqual({ top: 12, left: 40 });
	});
});
