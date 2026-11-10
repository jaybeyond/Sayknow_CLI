import { afterEach, describe, expect, it, vi } from "bun:test";
import { TodoCommandController } from "@sayknow-cli/coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@sayknow-cli/coding-agent/modes/types";
import {
	phasesToMarkdown,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@sayknow-cli/coding-agent/tools/todo-write";

const OSC_52 = "\u001b]52;c;c2VjcmV0\u0007";
const OSC_0 = "\u001b]0;evil title\u0007";
const OSC_8 = "\u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007";

function controllerFor(phases: TodoPhase[]) {
	const showStatus = vi.fn();
	const showError = vi.fn();
	const entries =
		phases.length === 0
			? []
			: [
					{
						type: "custom" as const,
						customType: USER_TODO_EDIT_CUSTOM_TYPE,
						data: { phases },
					},
				];
	const ctx = {
		sessionManager: {
			getBranch: () => entries,
			appendCustomEntry: vi.fn(),
			appendMessage: vi.fn(),
		},
		session: {
			getTodoPhases: () => [],
			setTodoPhases: vi.fn(),
		},
		setTodos: vi.fn(),
		agent: { appendMessage: vi.fn() },
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { controller: new TodoCommandController(ctx), showStatus, showError, entries };
}

function shownText(showStatus: ReturnType<typeof vi.fn>): string {
	expect(showStatus).toHaveBeenCalledTimes(1);
	const text = showStatus.mock.calls[0]?.[0];
	expect(typeof text).toBe("string");
	return text as string;
}

describe("/todo status display", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("strips an OSC sequence from a session todo task before showing the list", async () => {
		const phases: TodoPhase[] = [
			{
				name: `Ph${OSC_0}ase`,
				tasks: [
					{
						content: `Ship${OSC_52}\u001b[2Jit`,
						status: "pending",
						notes: [`see ${OSC_8} end`],
					},
				],
			},
		];
		const { controller, showStatus, showError, entries } = controllerFor(phases);

		await controller.handleTodoCommand("");

		const shown = shownText(showStatus);
		expect(shown).not.toContain("\u001b");
		expect(shown).not.toContain("c2VjcmV0");
		expect(shown).not.toContain("evil.example");
		expect(shown).not.toContain("evil title");
		expect(shown).toContain("# Phase");
		expect(shown).toContain("- [ ] Shipit");
		expect(shown).toContain("see link end");
		expect(showError).not.toHaveBeenCalled();
		expect(entries[0]?.data.phases[0]?.tasks[0]?.content).toContain(OSC_52);
	});

	it("shows an ordinary phase, task, and multiline note unchanged", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [
					{
						content: "Write  the report\tand more",
						status: "pending",
						notes: ["line one\nline two", "second note"],
					},
				],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("");

		expect(shownText(showStatus)).toBe(phasesToMarkdown(phases).trimEnd());
		expect(showError).not.toHaveBeenCalled();
	});

	it("shows the empty-list status when the session has no todos", async () => {
		const { controller, showStatus } = controllerFor([]);

		await controller.handleTodoCommand("");

		expect(shownText(showStatus)).toBe("No todos. Use /todo append <task> to start one.");
	});

	it("strips an OSC sequence when /todo start echoes a stored task", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [{ content: `Ship${OSC_52}it`, status: "pending" }],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("start Ship");

		const shown = shownText(showStatus);
		expect(shown).not.toContain("\u001b");
		expect(shown).not.toContain("c2VjcmV0");
		expect(shown).toBe("Started: Shipit");
		expect(showError).not.toHaveBeenCalled();
	});

	it("echoes an ordinary /todo start and /todo append unchanged", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Docs",
				tasks: [{ content: "Write the report", status: "pending" }],
			},
		];
		const { controller, showStatus, showError } = controllerFor(phases);

		await controller.handleTodoCommand("start Write");
		expect(shownText(showStatus)).toBe("Started: Write the report");

		showStatus.mockClear();
		await controller.handleTodoCommand('append "extra task"');
		expect(shownText(showStatus)).toBe("Appended to Docs: Extra task");
		expect(showError).not.toHaveBeenCalled();
	});
});
