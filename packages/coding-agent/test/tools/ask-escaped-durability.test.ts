import { describe, expect, it } from "bun:test";
import { AskTool } from "../../src/tools/ask";

describe("AskTool escaped non-ASCII durability", () => {
	it("declares only question text and option labels as display-safe", () => {
		const tool = new AskTool({} as never);
		expect(tool.displaySafeEscapedArgFields).toEqual(["questions.question", "questions.options.label"]);
		expect(tool.displaySafeEscapedArgFields).not.toContain("questions.id");
		expect(tool.displaySafeEscapedArgFields).not.toContain("questions.workflowGate");
		expect(tool.displaySafeEscapedArgFields).not.toContain("questions.deepInterview");
	});
});
