import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { initTheme, theme } from "../../src/modes/theme/theme";
import { findToolRenderer } from "../../src/tools/find";
import { renderFileList } from "../../src/tui/file-list";

beforeAll(async () => {
	await initTheme();
});

function renderFind(file: string, width = 120): string {
	const component = findToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "model copy" }],
			details: { fileCount: 1, files: [file] },
		},
		{ expanded: true, isPartial: false },
		theme,
		{ paths: ["."] },
	);
	return component.render(width).join("\n");
}

function renderList(path: string, meta?: string): string {
	return renderFileList(
		{
			files: [{ path, meta, absPath: "/repo/item" }],
			expanded: true,
			hyperlinkFn: (_abs, display) => display,
		},
		theme,
	).join("\n");
}

test("find result does not render terminal controls from file names", () => {
	const osc52 = "\x1b]52;c;aGVsbG8=\x07";
	const title = "\x1b]0;pwn-title\x07";
	const csi = "\x1b[2J";
	const dcs = "\x1bP+payload\x1b\\";
	const c1 = "\u009d0;c1title\u009c";
	const rendered = renderFind(`keep${osc52}tail\nbefore${title}after/x${csi}cleared/d${dcs}e/c${c1}z/notes.txt`);
	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("\x1b]0;pwn-title");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).not.toContain("\x1bP+payload");
	expect(rendered).not.toContain("\u009d");
	expect(rendered).not.toContain("aGVsbG8=");
	expect(rendered).not.toContain("pwn-title");
	expect(rendered).toContain("keep");
	expect(rendered).toContain("tail");
	expect(rendered).toContain("before");
	expect(rendered).toContain("after");
	expect(rendered).toContain("cleared");
	expect(rendered).toContain("notes.txt");
});

test("strips file-name controls before the caller width clip", () => {
	const osc = "\x1b]52;c;aGVsbG8=\x07";
	const narrow = renderFind(`keep${osc}tail-and-more-text`, 16);
	expect(narrow).not.toContain("\x1b]52;");
	expect(narrow).not.toContain("aGVsbG8=");
	const wide = renderFind(`keep${osc}tail-and-more-text`, 120);
	expect(wide).not.toContain("\x1b]52;");
	expect(wide).not.toContain("aGVsbG8=");
	expect(wide).toContain("keep");
	expect(wide).toContain("tail-and-more-text");
});

test("file list hands the hyperlink a name without terminal controls", () => {
	let seen = "";
	const rendered = renderFileList(
		{
			files: [{ path: "keep\x1b]52;c;aGVsbG8=\x07tail.ts", absPath: "/repo/tail.ts" }],
			expanded: true,
			hyperlinkFn: (_absPath, display) => {
				seen = display;
				return display;
			},
		},
		theme,
	).join("\n");
	expect(seen).not.toContain("\x1b]52;");
	expect(seen).not.toContain("aGVsbG8=");
	expect(rendered).toContain("keep");
	expect(rendered).toContain("tail.ts");
});

test("file list meta does not render terminal controls", () => {
	const rendered = renderList("src/notes.txt", "2 KB\x1b]52;c;aGVsbG8=\x07");
	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("aGVsbG8=");
	expect(rendered).toContain("src/notes.txt");
	expect(rendered).toContain("2 KB");
});

test("still allows a parent directory, letter case, surrounding whitespace, and a Windows path", () => {
	for (const name of ["../lib/a.ts", "Src/ReadMe.MD", "  notes.txt  ", "src\\notes.txt", "C:\\Src\\ReadMe.TXT"]) {
		const rendered = renderFind(name);
		expect(rendered).toContain(name);
	}
});

test("still allows a trailing-slash directory name and literal brackets", () => {
	const directory = renderFind("src/lib/");
	expect(directory).toContain("src/lib/");
	const literal = renderFind("see [31m] and ESC c later.ts");
	expect(literal).toContain("[31m]");
	expect(literal).toContain("ESC c later.ts");
});

test("still allows a directional mark in a file name", () => {
	const name = "readme\u202e.txt";
	const rendered = renderFind(name);
	expect(rendered).toContain("readme");
	expect(rendered).toContain("\u202e");
	expect(rendered).toContain(".txt");
});

test("still allows a tab-separated file name", () => {
	const tabbed = renderFind("alpha\tbeta.ts");
	expect(tabbed).toContain("alpha");
	expect(tabbed).toContain("beta.ts");
	expect(tabbed).not.toContain("\t");
});

test("a carriage return inside a file name does not rewind the label", () => {
	const overwritten = renderFind("hidden\rvisible.ts");
	expect(overwritten).toContain("hidden");
	expect(overwritten).toContain("visible.ts");
	expect(overwritten).not.toContain("\r");
});

test("property: injected terminal controls are absent from find file names, fc.property seed 62921, numRuns 64", () => {
	const mark = fc.stringMatching(/^[A-Za-z]{6,12}$/);
	const wrapper = fc.constantFrom(
		(value: string) => `\x1b]0;${value}\x07`,
		(value: string) => `\x1b]52;c;${value}\x07`,
		(value: string) => `\x1bP${value}\x1b\\`,
		(_value: string) => `\x1b[2J`,
		(value: string) => `\u009d${value}\u009c`,
	);
	fc.assert(
		fc.property(mark, wrapper, (token, wrap) => {
			const sequence = wrap(token);
			const rendered = renderFind(`keep${sequence}tail`);
			const payloadStripped =
				sequence.startsWith("\x1b]0;") || sequence.startsWith("\x1b]52;") || sequence.startsWith("\x1bP");
			return (
				!rendered.includes(sequence) &&
				!rendered.includes("\u009d") &&
				rendered.includes("keep") &&
				rendered.includes("tail") &&
				(!payloadStripped || !rendered.includes(token))
			);
		}),
		{ seed: 62921, numRuns: 64 },
	);
});

test("property: ordinary file names stay visible, fc.property seed 62922, numRuns 64", () => {
	const name = fc.stringMatching(/^[A-Za-z0-9 ._/\\()-]{1,24}$/);
	fc.assert(
		fc.property(name, value => renderFind(value).includes(value)),
		{ seed: 62922, numRuns: 64 },
	);
});
