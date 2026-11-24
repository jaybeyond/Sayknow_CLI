import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CombinedAutocompleteProvider, Container } from "@sayknow-cli/tui";
import { Editor, type EditorAction, fitHintText } from "@sayknow-cli/tui/components/editor";
import { truncateToWidth, visibleWidth } from "@sayknow-cli/tui/utils";
import { defaultEditorTheme } from "./test-themes";

const BOLD_SEND = "\x1b[1mSend\x1b[22m";

const ACTIONS: EditorAction[] = [
	{ id: "attach", label: "@ Attach" },
	{ id: "send", label: "Send", primary: true },
];

function railEditor(): Editor {
	const editor = new Editor({ ...defaultEditorTheme, actionStyle: text => `\x1b[1m${text}\x1b[22m` });
	editor.setBorderVisible(false);
	editor.setRailGutter("▌");
	editor.setActions(ACTIONS);
	return editor;
}

function plain(lines: string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line));
}

describe("Editor action rail", () => {
	it("draws the actions at the right end of the last input row only", () => {
		const editor = railEditor();
		editor.setText("first line\nsecond line");

		const lines = plain(editor.render(80));

		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toContain("Attach");
		expect(lines[1]!.endsWith("@ Attach  Send ")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});

	it("wraps typed text before the rail instead of running under it", () => {
		const editor = railEditor();
		editor.setText("x".repeat(70));

		const lines = plain(editor.render(80));

		expect(lines.length).toBeGreaterThan(1);
		const railStart = 80 - " @ Attach  Send ".length - 1;
		for (const line of lines) expect(line.slice(railStart)).not.toContain("x");
	});

	it("styles the primary action only while there is a draft to send", () => {
		const editor = railEditor();
		expect(editor.render(80).join("")).not.toContain(BOLD_SEND);

		editor.setText("hello");
		expect(editor.render(80).join("")).toContain(BOLD_SEND);

		editor.disableSubmit = true;
		expect(editor.render(80).join("")).not.toContain(BOLD_SEND);
	});

	it("drops the rail when it would leave too little room to type", () => {
		const editor = railEditor();
		editor.setText("hi");

		expect(plain(editor.render(50)).join("")).not.toContain("Attach");
	});

	it("ignores actions while the border is visible", () => {
		const editor = railEditor();
		editor.setBorderVisible(true);

		expect(plain(editor.render(80)).join("")).not.toContain("Attach");
	});

	it("stops taking clicks as soon as the border is shown, before the next render", () => {
		const editor = railEditor();
		const activated: string[] = [];
		editor.onAction = id => activated.push(id);
		const [line] = plain(editor.render(80));
		const sendColumn = line!.lastIndexOf("Send");
		editor.setBorderVisible(true);

		expect(editor.handleClick(0, sendColumn)).toBe(false);
		expect(activated).toEqual([]);
	});

	it("maps clicks on a label to its action and ignores clicks elsewhere", () => {
		const editor = railEditor();
		const activated: string[] = [];
		editor.onAction = id => activated.push(id);
		editor.setText("one\ntwo");
		const lines = plain(editor.render(80));
		const row = lines.length - 1;
		const attachColumn = lines[row]!.indexOf("@ Attach");
		const sendColumn = lines[row]!.lastIndexOf("Send");

		expect(editor.handleClick(row, attachColumn)).toBe(true);
		expect(editor.handleClick(row, sendColumn + 3)).toBe(true);
		expect(editor.handleClick(row, attachColumn + "@ Attach".length)).toBe(false);
		expect(editor.handleClick(0, sendColumn)).toBe(false);
		expect(editor.handleClick(row, 2)).toBe(false);
		expect(activated).toEqual(["attach", "send"]);
	});

	it("routes a click through a container to the editor row it landed on", () => {
		const editor = railEditor();
		const activated: string[] = [];
		editor.onAction = id => activated.push(id);
		const header = { render: () => ["header"], invalidate: () => {} };
		const container = new Container();
		container.addChild(header);
		container.addChild(editor);
		const lines = plain(container.render(80));
		const sendColumn = lines[1]!.lastIndexOf("Send");

		expect(container.handleClick(0, sendColumn)).toBe(false);
		expect(container.handleClick(1, sendColumn)).toBe(true);
		expect(activated).toEqual(["send"]);
	});

	it("submits the draft like the submit key", () => {
		const editor = railEditor();
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.setText("  ship it  ");

		editor.submit();

		expect(submitted).toEqual(["ship it"]);
		expect(editor.getText()).toBe("");
	});

	it("does not submit while submit is disabled", () => {
		const editor = railEditor();
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.setText("draft");
		editor.disableSubmit = true;

		editor.submit();

		expect(submitted).toEqual([]);
		expect(editor.getText()).toBe("draft");
	});

	it("completes a partly typed slash command before submitting, like the submit key", () => {
		const editor = railEditor();
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "model", description: "Switch AI model", value: "model" }], "/tmp"),
		);
		const submitted: string[] = [];
		editor.onSubmit = text => submitted.push(text);
		editor.setText("/mode");

		editor.submit();

		expect(submitted).toEqual(["/model"]);
	});

	it("submits the highlighted slash command from an open list, like the submit key", async () => {
		const provider = () =>
			new CombinedAutocompleteProvider(
				[
					{ name: "model", description: "Switch AI model", value: "model" },
					{ name: "mode", description: "Change editor mode", value: "mode" },
				],
				"/tmp",
			);
		const viaClick = railEditor();
		viaClick.setAutocompleteProvider(provider());
		const clicked: string[] = [];
		viaClick.onSubmit = text => clicked.push(text);
		viaClick.handleInput("/mo");
		await Bun.sleep(0);
		expect(viaClick.isShowingAutocomplete()).toBe(true);
		viaClick.handleInput("\x1b[B");
		viaClick.submit();

		const viaKey = railEditor();
		viaKey.setAutocompleteProvider(provider());
		const keyed: string[] = [];
		viaKey.onSubmit = text => keyed.push(text);
		viaKey.handleInput("/mo");
		await Bun.sleep(0);
		viaKey.handleInput("\x1b[B");
		viaKey.handleInput("\r");

		expect(clicked).toHaveLength(1);
		expect(clicked).toEqual(keyed);
	});

	it("starts a file reference separated from the word before the cursor", () => {
		const empty = railEditor();
		empty.beginFileReference();
		expect(empty.getText()).toBe("@");

		const afterWord = railEditor();
		afterWord.setText("look at");
		afterWord.beginFileReference();
		expect(afterWord.getText()).toBe("look at @");

		const afterSpace = railEditor();
		afterSpace.setText("look at ");
		afterSpace.beginFileReference();
		expect(afterSpace.getText()).toBe("look at @");
	});
});

describe("fitHintText", () => {
	// The busy composer placeholder built by the coding agent.
	const hint = "Type your message · ↩ Steer · ⌥Q Queue · ⇧↩/⌃J New line";

	it("keeps text that fits", () => {
		expect(fitHintText(hint, 80)).toBe(hint);
	});

	it("drops whole trailing entries instead of cutting a label", () => {
		expect(fitHintText(hint, 45)).toBe("Type your message · ↩ Steer · ⌥Q Queue");
		expect(fitHintText(hint, 30)).toBe("Type your message · ↩ Steer");
		expect(fitHintText(hint, 17)).toBe("Type your message");
	});

	it("truncates the first entry only when nothing whole fits", () => {
		const fitted = fitHintText(hint, 10);
		expect(visibleWidth(fitted)).toBeLessThanOrEqual(10);
		expect(fitted.startsWith("Type")).toBe(true);
	});

	it("leaves an ellipsis inside ghost text alone", () => {
		expect(fitHintText("Wait... then run the tests again", 12)).toBe(
			truncateToWidth("Wait... then run the tests again", 12),
		);
	});
});
