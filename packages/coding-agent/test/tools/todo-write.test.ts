import { describe, expect, it } from "bun:test";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import { type TodoPhase, TodoWriteTool } from "@sayknow-cli/coding-agent/tools";
import { phasesToMarkdown } from "../../src/tools/todo-write";

function createSession(initialPhases: TodoPhase[] = []): ToolSession {
	let phases = initialPhases;
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

describe("TodoWriteTool auto-start behavior", () => {
	it("auto-starts the first task after init", async () => {
		const tool = new TodoWriteTool(createSession());
		const result = await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (2):");
		expect(summary.text).toContain("status [in_progress] (Execution)");
		expect(summary.text).toContain("diagnostics [pending] (Execution)");
	});

	it("auto-promotes the next pending task when current task is completed", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", task: "status" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary from todo_write");
		expect(summary.text).toContain("Remaining items (1):");
		expect(summary.text).toContain("diagnostics [in_progress] (Execution)");

		const completedResult = await tool.execute("call-3", { ops: [{ op: "done", task: "diagnostics" }] });
		const completedSummary = completedResult.content.find(part => part.type === "text");
		if (completedSummary?.type !== "text") {
			throw new Error("Expected text summary from todo_write");
		}
		expect(completedSummary.text).toContain("Remaining items: none.");
	});
});

describe("TodoWriteTool ops operations", () => {
	it("jumps to a specific task out of order", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "third" }] });

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("demotes the current in_progress task when starting another", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "A", items: ["a1", "a2"] },
						{ phase: "B", items: ["b1"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "start", task: "b1" }] });

		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["pending", "pending", "in_progress"]);
	});

	it("appends items to an existing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Work",
					items: ["Second"],
				},
			],
		});

		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => ({ content: task.content, status: task.status }))).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("creates a phase when append targets a missing phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [{ op: "init", list: [{ phase: "Work", items: ["First"] }] }],
		});

		const result = await tool.execute("call-2", {
			ops: [
				{
					op: "append",
					phase: "Cleanup",
					items: ["Remove dead code"],
				},
			],
		});

		expect(result.details?.phases.map(phase => phase.name)).toEqual(["Work", "Cleanup"]);
		expect(result.details?.phases[1]?.tasks.map(task => task.content)).toEqual(["Remove dead code"]);
	});

	it("marks all tasks in a phase done", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [
						{ phase: "Work", items: ["First", "Second"] },
						{ phase: "Later", items: ["Third"] },
					],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "done", phase: "Work" }] });
		const allTasks = result.details?.phases.flatMap(phase => phase.tasks) ?? [];
		expect(allTasks.map(task => task.status)).toEqual(["completed", "completed", "in_progress"]);
	});

	it("removes all tasks when rm omits task and phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "rm" }] });
		expect(result.details?.phases[0]?.tasks).toEqual([]);
		const summary = result.content.find(part => part.type === "text");
		if (summary?.type !== "text") throw new Error("Expected text summary");
		expect(summary.text).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", async () => {
		const tool = new TodoWriteTool(createSession());
		await tool.execute("call-1", {
			ops: [
				{
					op: "init",
					list: [{ phase: "Work", items: ["First", "Second"] }],
				},
			],
		});

		const result = await tool.execute("call-2", { ops: [{ op: "drop", phase: "Work" }] });
		const tasks = result.details?.phases[0]?.tasks ?? [];
		expect(tasks.map(task => task.status)).toEqual(["abandoned", "abandoned"]);
	});
});

/**
 * `TodoItem.notes` is only typed as `string[]`: a persisted session or a bridged
 * caller reaches the tool with whatever the stored array holds.
 */
function phasesWithRawNotes(notes: unknown[]): TodoPhase[] {
	return [
		{
			name: "Work",
			tasks: [{ content: "Apply fix", status: "in_progress", notes: notes as string[] }],
		},
	];
}

describe("TodoWriteTool note robustness", () => {
	it("returns a result when a stored note is not a string", async () => {
		// Every render path called `.split("\n")` on each note, so one non-string
		// element (real sessions reported `a.notes[f].split is not a function`)
		// turned the call into a rejected promise instead of a tool result.
		const tool = new TodoWriteTool(createSession(phasesWithRawNotes([42])));

		const result = await tool.execute("call-raw-note", {
			ops: [{ op: "note", task: "Apply fix", text: "keep going" }],
		});

		const text = result.content.map(block => ("text" in block ? block.text : "")).join("\n");
		expect(text).toContain("42");
		expect(text).toContain("keep going");
		expect(text).toContain("(+2 notes)");
		expect(result.isError).toBeUndefined();
		const notes = result.details?.phases[0]?.tasks[0]?.notes ?? [];
		expect(notes).toHaveLength(2);
		expect(notes).toContain("keep going");
	});

	it("rejects a non-string note body with an actionable message", async () => {
		// Bridges that call execute directly skip raw validation, so the body has to
		// be checked here instead of being stored and crashing a later render.
		const tool = new TodoWriteTool(
			createSession([{ name: "Work", tasks: [{ content: "Apply fix", status: "in_progress" }] }]),
		);

		const result = await tool.execute("call-object-note", {
			ops: [{ op: "note", task: "Apply fix", text: { item: "x" } as unknown as string }],
		});

		expect(result.isError).toBe(true);
		const text = result.content.map(block => ("text" in block ? block.text : "")).join("\n");
		expect(text).toContain("Note text must be a string");
		expect(text).toContain('Pass the note body as "text"');
		// The fork reports op errors without upstream's transactional "not applied" wording.
		expect(result.details?.phases[0]?.tasks[0]?.notes).toBeUndefined();
	});

	it("renders a stored non-string note in the markdown round-trip", () => {
		const markdown = phasesToMarkdown(phasesWithRawNotes([{ item: "x" }]));
		expect(markdown).toContain('  > {"item":"x"}');
	});
});
