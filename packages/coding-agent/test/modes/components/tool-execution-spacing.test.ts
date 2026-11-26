import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@sayknow-cli/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@sayknow-cli/coding-agent/config/settings";
import { type IrcSidebarTheme, IrcSplitViewComponent } from "@sayknow-cli/coding-agent/modes/components/irc-sidebar";
import { ToolExecutionComponent } from "@sayknow-cli/coding-agent/modes/components/tool-execution";
import { IrcObservationLedger } from "@sayknow-cli/coding-agent/modes/irc-observation-ledger";
import * as themeModule from "@sayknow-cli/coding-agent/modes/theme/theme";
import { getKeybindings, ImageProtocol, setKeybindings, TERMINAL, type TUI } from "@sayknow-cli/tui";
import { getLanguage, setLanguage } from "../../../src/i18n";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-octopus", "blue-octopus");
});

const uiStub = { requestRender() {} } as unknown as TUI;

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
const originalImageProtocol = TERMINAL.imageProtocol;
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

afterEach(() => {
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	terminal.imageProtocol = originalImageProtocol;
});

function renderTool(command: string): string[] {
	const component = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `output of ${command}` }], isError: false }, false);
	return component.render(80).map(line => Bun.stripANSI(line));
}

function countEdgeBlanks(lines: string[]): { leading: number; trailing: number } {
	let leading = 0;
	for (let i = 0; i < lines.length && lines[i].trim() === ""; i++) leading++;
	let trailing = 0;
	for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) trailing++;
	return { leading, trailing };
}

// 083.2: block separation is exactly the leading Spacer (1 blank line above each
// block); the content box itself has no vertical padding. Two consecutive tools
// must be separated by exactly 1 blank line.
describe("ToolExecutionComponent spacing", () => {
	it("renders exactly one blank line above and none below a tool block", () => {
		const lines = renderTool("ls -la");
		const { leading, trailing } = countEdgeBlanks(lines);
		expect(leading).toBe(1);
		expect(trailing).toBe(0);
	});

	it("separates consecutive tool blocks by exactly one blank line", () => {
		const a = renderTool("ls -la");
		const b = renderTool("git status");
		const { trailing } = countEdgeBlanks(a);
		const { leading } = countEdgeBlanks(b);
		expect(trailing + leading).toBe(1);
	});

	it("folds successful output into one line and restores its details when expanded", () => {
		const component = new ToolExecutionComponent("bash", { command: "git status" }, {}, undefined, uiStub);
		component.updateResult({ content: [{ type: "text", text: "working tree\nsecond detail line" }] }, false);
		const collapsed = component
			.render(52)
			.map(line => Bun.stripANSI(line))
			.filter(line => line.trim());
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("working tree");
		expect(collapsed[0]).not.toContain("second detail line");
		component.setManuallyExpanded(true);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("second detail line");
	});

	it("shows the configured expand key in the interface language and hides it when unbound", () => {
		const previousKeys = getKeybindings();
		const previousLanguage = getLanguage();
		const component = new ToolExecutionComponent("bash", { command: "git status" }, {}, undefined, uiStub);
		component.updateResult({ content: [{ type: "text", text: "작업 완료\n세부 정보" }] }, false);
		const render = (width: number) => Bun.stripANSI(component.render(width).join("\n"));
		try {
			setLanguage("ko");
			const custom = KeybindingsManager.inMemory({ "app.tools.expand": "ctrl+x" });
			custom.setDisplayContext({ platform: "darwin" });
			setKeybindings(custom);
			expect(render(52)).toContain("⌃X 펼치기");
			expect(render(52)).not.toContain("Ctrl+O");
			setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": [] }));
			expect(render(52)).not.toContain("펼치기");
			expect(render(52)).toContain("작업 완료");
		} finally {
			setKeybindings(previousKeys);
			setLanguage(previousLanguage);
		}
	});
});
it("preserves manual expansion through automatic updates and drops it on remount", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setManuallyExpanded(true);
	component.setExpanded(false);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");

	const remounted = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	remounted.setExpanded(false);
	expect(Bun.stripANSI(remounted.render(80).join("\n"))).not.toContain("Args");
});

it("lets untouched components follow automatic expansion", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setExpanded(true);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");
});

it("replaces generic SIXEL output while the IRC sidebar is visible and restores passthrough when hidden", () => {
	terminal.imageProtocol = ImageProtocol.Sixel;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	const sixel = "\x1bPqcustom-image\x1b\\";
	const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `before\n${sixel}\nafter` }], isError: false }, false);
	const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), sidebarTheme);

	expect(split.render(120).join("\n")).toContain(sixel);
	split.setVisible(true);
	const visible = split.render(120).join("\n");
	expect(visible).not.toContain("\x1bP");
	expect(Bun.stripANSI(visible).split("[SIXEL image hidden while IRC sidebar is visible]").length - 1).toBe(1);
	split.setVisible(false);
	expect(split.render(120).join("\n")).toContain(sixel);
});
