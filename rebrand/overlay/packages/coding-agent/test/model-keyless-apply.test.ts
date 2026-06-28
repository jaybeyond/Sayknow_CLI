// Regression: keyless / no-auth providers (local LLMs, `--auth none` custom
// providers, and any provider whose credential resolves to the kNoAuth "N/A"
// sentinel) must be treated as USABLE by the model-selector auth gate and by
// model-profile activation. Before the fix, both gates used isAuthenticated(),
// which deliberately rejects kNoAuth, so picking such a provider's preset
// silently bailed into a login flow (kind:"login") — and, if forced through,
// activation threw "requires credentials" — instead of applying the model.
import { beforeAll, describe, expect, test, vi } from "bun:test";
import { Effort, type Model } from "@sayknow-cli/ai";
import { prepareModelProfileActivation } from "@sayknow-cli/coding-agent/config/model-profile-activation";
import { kNoAuth } from "@sayknow-cli/coding-agent/config/model-registry";
import type { ModelProfileDefinition } from "@sayknow-cli/coding-agent/config/model-profiles";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import {
	ModelSelectorComponent,
	type ModelSelectorSelection,
} from "@sayknow-cli/coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@sayknow-cli/coding-agent/modes/theme/theme";
import type { TUI } from "@sayknow-cli/tui";

const localModel: Model = {
	provider: "local-llm",
	id: "my-local-model",
	name: "my-local-model",
	api: "openai-completions",
	contextWindow: 1000,
	maxTokens: 1000,
	thinking: { minLevel: Effort.Low, maxLevel: Effort.XHigh, mode: "effort" },
} as Model;

const localPreset: ModelProfileDefinition = {
	name: "local-preset",
	requiredProviders: ["local-llm"],
	modelMapping: { default: "local-llm/my-local-model" },
	source: "user",
};

// Registry whose provider resolves to the kNoAuth sentinel — i.e. a keyless /
// no-auth provider that is usable WITHOUT an API key.
function createKeylessRegistry() {
	const profiles = new Map([[localPreset.name, localPreset]]);
	return {
		refresh: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => [localModel],
		getAll: () => [localModel],
		getDiscoverableProviders: () => [],
		getCanonicalModels: () => [],
		resolveCanonicalModel: () => undefined,
		getCanonicalVariants: () => [],
		getCanonicalId: () => undefined,
		getModelProfiles: () => new Map(profiles),
		getModelProfile: (name: string) => profiles.get(name),
		getAvailableModelProfileNames: () => [...profiles.keys()],
		getApiKeyForProvider: async (_provider: string) => kNoAuth,
		getApiKey: async () => kNoAuth,
	};
}

describe("keyless / no-auth provider model apply", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("red-octopus");
		if (theme) setThemeInstance(theme);
	});

	test("selecting a keyless preset applies it instead of bailing to login", async () => {
		const selections: ModelSelectorSelection[] = [];
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = new ModelSelectorComponent(
			ui,
			undefined,
			Settings.isolated(),
			createKeylessRegistry() as never,
			[],
			(selection: ModelSelectorSelection) => {
				selections.push(selection);
			},
			() => {},
			{ sessionId: "sess-keyless" },
		);
		// Allow #loadModels + #refreshProviderAuth to resolve.
		await Bun.sleep(30);

		selector.handleInput("\x1b[C"); // expand the provider group
		selector.handleInput("\x1b[B"); // move onto the preset row
		selector.handleInput("\n"); // preview the preset
		selector.handleInput("\n"); // open the apply/scope menu
		selector.handleInput("\n"); // confirm "apply for this session"

		// Must NOT have dispatched a login flow for the keyless provider.
		expect(selections.some(s => s.kind === "login")).toBe(false);
		// Must have applied the profile.
		const applied = selections.find(s => s.kind === "profile");
		expect(applied).toBeDefined();
		expect((applied as { profileName: string }).profileName).toBe("local-preset");
	});

	test("prepareModelProfileActivation does not reject a keyless provider", async () => {
		const prepared = await prepareModelProfileActivation({
			session: { model: localModel, thinkingLevel: undefined, sessionId: "sess-keyless" } as never,
			modelRegistry: createKeylessRegistry() as never,
			settings: { get: () => undefined } as never,
			profileName: "local-preset",
		});
		// The auth gate passed (no "requires credentials" throw) and the profile
		// resolved to the keyless model.
		expect(prepared.profileName).toBe("local-preset");
	});
});
