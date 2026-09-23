/**
 * The two-level `/model` assignment flow.
 *
 * The first level keeps its seven rows in their original order. The second
 * level exists so a role can be pointed at a *kind of work* rather than only at
 * the role as a whole, and the rules that matter are the ones a wrong
 * implementation would quietly violate: a role is only ever offered specialties
 * it can actually run, and the bulk rows never touch specialty settings.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@sayknow-cli/agent-core";
import { Effort, type Model } from "@sayknow-cli/ai";
import type { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { ModelSelectorComponent } from "@sayknow-cli/coding-agent/modes/components/model-selector";
import {
	getThemeByName,
	setSymbolPreset,
	setTheme,
	setThemeInstance,
} from "@sayknow-cli/coding-agent/modes/theme/theme";
import type { TUI } from "@sayknow-cli/tui";
import { getLanguage, setLanguage } from "../src/i18n";

const DOWN = "\x1b[B";
const ENTER = "\n";
const ESCAPE = "\x1b";

function normalize(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function testModel(): Model {
	return {
		id: "assignment-test",
		name: "assignment-test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		thinking: { minLevel: Effort.Low, maxLevel: Effort.High, defaultLevel: Effort.Medium, mode: "effort" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}

interface Capture {
	kind: string;
	role?: string | null;
	specialty?: string;
	selector?: string;
	thinkingLevel?: ThinkingLevel;
}

function createSelector(settings: Settings, onSelect: (selection: Capture) => void = () => {}) {
	const model = testModel();
	const modelRegistry = {
		getAll: () => [model],
		hasConfiguredProviderAuth: () => false,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
	} as unknown as ModelRegistry;
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ModelSelectorComponent(
		ui,
		model,
		settings,
		modelRegistry,
		[{ model, thinkingLevel: ThinkingLevel.Off, explicitThinkingLevel: true }],
		selection => onSelect(selection as unknown as Capture),
		() => {},
		{},
	);
}

let testTheme = await getThemeByName("red-octopus");

function installTestTheme(): void {
	if (testTheme) setThemeInstance(testTheme);
	setTheme("red-octopus");
	setSymbolPreset("ascii");
}

/** Open the action menu, walk down `steps` rows, and commit. */
function openRole(selector: ModelSelectorComponent, steps: number): void {
	selector.handleInput(ENTER);
	for (let i = 0; i < steps; i++) selector.handleInput(DOWN);
	selector.handleInput(ENTER);
}

// These assertions are about UI copy, so the locale has to be pinned rather
// than inherited. Another suite that restores the real agent directory reloads
// the developer's own `language` setting, which would otherwise decide whether
// this file passes.
let previousLanguage: string | undefined;

beforeAll(async () => {
	previousLanguage = getLanguage();
	setLanguage("en");
	testTheme = await getThemeByName("red-octopus");
	installTestTheme();
});

afterAll(() => {
	if (previousLanguage) setLanguage(previousLanguage as never);
});

describe("first level", () => {
	test("keeps its seven rows in the original order", async () => {
		installTestTheme();
		const selector = createSelector(Settings.isolated());
		await Bun.sleep(0);
		installTestTheme();

		selector.handleInput(ENTER);
		const rendered = normalize(selector.render(220).join("\n"));

		const order = ["DEFAULT", "EXECUTOR", "ARCHITECT", "PLANNER", "CRITIC"].map(tag => rendered.indexOf(tag));
		expect(order.every(index => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(rendered).toContain("Set for all role agents");
		expect(rendered).toContain("Set for all targets");
	});
});

describe("second level", () => {
	test("an executor is offered only the specialties it can run", async () => {
		installTestTheme();
		const selector = createSelector(Settings.isolated());
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 1);
		const rendered = normalize(selector.render(220).join("\n"));

		expect(rendered).toContain("General (whole role)");
		expect(rendered).toContain("Implementation");
		expect(rendered).toContain("Testing");
		// Planning and review work belong to other roles; offering them here would
		// let the user write a setting the router is required to ignore.
		expect(rendered).not.toContain("Backend architecture");
		expect(rendered).not.toContain("Frontend design");
		expect(rendered).not.toContain("Review");
	});

	test("a planner is offered the two design specialties and neither executor one", async () => {
		installTestTheme();
		const selector = createSelector(Settings.isolated());
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 3);
		const rendered = normalize(selector.render(220).join("\n"));

		expect(rendered).toContain("Backend architecture");
		expect(rendered).toContain("Frontend design");
		expect(rendered).not.toContain("Implementation");
		expect(rendered).not.toContain("Testing");
	});

	test("a critic is offered review only", async () => {
		installTestTheme();
		const selector = createSelector(Settings.isolated());
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 4);
		const rendered = normalize(selector.render(220).join("\n"));

		expect(rendered).toContain("Review");
		expect(rendered).not.toContain("Implementation");
		expect(rendered).not.toContain("Backend architecture");
	});

	test("a row states the model it already holds", async () => {
		installTestTheme();
		const settings = Settings.isolated({
			"task.modelRouting.specialtyModels": { testing: "anthropic/claude-haiku-4-5:low" },
		} as never);
		const selector = createSelector(settings);
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 1);
		const rendered = normalize(selector.render(220).join("\n"));

		expect(rendered).toContain("anthropic/claude-haiku-4-5:low");
	});
});

describe("selection", () => {
	test("General assigns the whole role and emits no specialty", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 1);
		selector.handleInput(ENTER);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.kind).toBe("assignment");
		expect(captured[0]?.role).toBe("executor");
		expect(captured[0]?.specialty).toBeUndefined();
	});

	test("a specialty row emits a specialty assignment carrying the effort", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 1);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.kind).toBe("specialtyAssignment");
		expect(captured[0]?.role).toBe("executor");
		expect(captured[0]?.specialty).toBe("implementation");
		// The selector must be dispatchable as-is, which means the effort travels
		// with it exactly like a canonical role assignment.
		expect(captured[0]?.selector).toContain("openai/assignment-test");
	});

	test("the reset row emits a reset for that role and nothing else", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		// executor: General, implementation, testing, reset
		openRole(selector, 1);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.kind).toBe("specialtyReset");
		expect(captured[0]?.role).toBe("executor");
	});

	test("a bulk row never opens the second level and never writes a specialty", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		// Row 5 is "Set for all role agents".
		openRole(selector, 5);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.kind).toBe("assignment");
		expect(captured.every(selection => selection.kind !== "specialtyAssignment")).toBe(true);
	});

	test("default has no specialties and assigns in one keystroke", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 0);

		expect(captured).toHaveLength(1);
		expect(captured[0]?.kind).toBe("assignment");
		expect(captured[0]?.role).toBe("default");
	});
});

describe("navigation", () => {
	test("cancelling the second level returns to the row that opened it", async () => {
		installTestTheme();
		const captured: Capture[] = [];
		const selector = createSelector(Settings.isolated(), selection => captured.push(selection));
		await Bun.sleep(0);
		installTestTheme();

		openRole(selector, 3);
		selector.handleInput(ESCAPE);
		const rendered = normalize(selector.render(220).join("\n"));

		// Back on the action menu with PLANNER still under the cursor, and nothing
		// committed on the way out.
		expect(rendered).toContain("Set for all targets");
		expect(captured).toHaveLength(0);
		selector.handleInput(ENTER);
		const detail = normalize(selector.render(220).join("\n"));
		expect(detail).toContain("Backend architecture");
	});
});
