import { beforeEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@sayknow-cli/ai";
import type { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { ModelSelectorComponent } from "@sayknow-cli/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@sayknow-cli/coding-agent/modes/theme/theme";
import type { TUI } from "@sayknow-cli/tui";

const model = (provider: string, id: string, name: string): Model =>
	({ provider, id, name, api: "anthropic-messages", contextWindow: 1000, maxTokens: 1000 }) as Model;

const opus55 = model("anthropic", "claude-opus-5-5", "Anthropic Opus 5.5");
const opus5 = model("anthropic", "claude-opus-5", "Anthropic Opus 5");
const opus45 = model("anthropic", "claude-opus-4-5-20251101", "Anthropic Opus 4.5");
const sonnet5 = model("anthropic", "claude-sonnet-5", "Anthropic Sonnet 5");
const gpt54 = model("openai-codex", "gpt-5.4", "GPT-5.4");
const models = [opus55, opus5, opus45, sonnet5, gpt54];

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function createRegistry(): ModelRegistry {
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [...models],
		getAll: () => [...models],
		hasConfiguredProviderAuth: () => true,
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getModelProfiles: () => new Map(),
		getApiKeyForProvider: async () => "key",
		getApiKey: async () => "key",
	} as unknown as ModelRegistry;
}

async function createSelector(): Promise<ModelSelectorComponent> {
	const selector = new ModelSelectorComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		undefined,
		Settings.isolated(),
		createRegistry(),
		[],
		() => {},
		() => {},
		{ temporaryOnly: true },
	);
	await Bun.sleep(10);
	return selector;
}

function visibleSelectors(selector: ModelSelectorComponent): string[] {
	const keys = models.map(candidate => `${candidate.provider}/${candidate.id}`).sort((a, b) => b.length - a.length);
	return selector
		.render(240)
		.map(stripAnsi)
		.flatMap(line => {
			const normalized = line.trimStart().replace(/^❯\s+/, "");
			const key = keys.find(candidate => normalized.startsWith(candidate));
			return key ? [key] : [];
		});
}

async function search(query: string): Promise<string[]> {
	const selector = await createSelector();
	for (const ch of query) selector.handleInput(ch);
	return visibleSelectors(selector);
}

beforeEach(async () => {
	const theme = await getThemeByName("red-octopus");
	if (!theme) throw new Error("Failed to load test theme");
	setThemeInstance(theme);
});

describe("model list search", () => {
	test("vendor-style version punctuation matches the dashed id", async () => {
		// "opus 5.5" used to return "No matching models": the ALL tab fuzzy-matched
		// only `${id} ${provider}`, and "5.5" cannot be a subsequence of "5-5".
		const rows = await search("opus 5.5");
		expect(rows[0]).toBe("anthropic/claude-opus-5-5");
		expect(rows).not.toContain("anthropic/claude-sonnet-5");
		expect(rows).not.toContain("openai-codex/gpt-5.4");
	});

	test("bare version query matches by display name", async () => {
		const rows = await search("5.5");
		expect(rows).toContain("anthropic/claude-opus-5-5");
		expect(rows).not.toContain("anthropic/claude-sonnet-5");
	});

	test("dashed id query still matches", async () => {
		const rows = await search("opus-5-5");
		expect(rows[0]).toBe("anthropic/claude-opus-5-5");
	});

	test("alpha tokens narrow before fuzzy ranking", async () => {
		const rows = await search("sonnet");
		expect(rows).toEqual(["anthropic/claude-sonnet-5"]);
	});

	test("unmatched query falls back to fuzzy over the display text", async () => {
		const rows = await search("gpt54");
		expect(rows).toEqual(["openai-codex/gpt-5.4"]);
	});
});
