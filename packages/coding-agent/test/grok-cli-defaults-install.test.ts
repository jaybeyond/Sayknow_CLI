import { describe, expect, it } from "bun:test";
import { Effort } from "@sayknow-cli/ai/model-thinking";
import {
	type GrokCliModelConfig,
	resolveModels,
	supportsReasoningEffort,
} from "../src/defaults/skc/extensions/grok-cli-vendor/src/models/catalog";
import {
	assertBundledGrokCliDefaults,
	getBundledGrokBuildExtensionFactory,
	getBundledGrokCliModelDefaults,
} from "../src/defaults/skc-grok-cli";
import type { ExtensionAPI, ProviderConfig } from "../src/extensibility/extensions";

async function captureGrokBuildProviderConfig(): Promise<ProviderConfig> {
	let providerConfig: ProviderConfig | undefined;
	await getBundledGrokBuildExtensionFactory()({
		registerProvider(name: string, config: ProviderConfig) {
			if (name === "grok-build") providerConfig = config;
		},
		on() {},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	if (!providerConfig) throw new Error("Grok Build provider was not registered");
	return providerConfig;
}

describe("bundled Grok CLI defaults", () => {
	it("loads the shipped vendor defaults without filesystem path discovery", async () => {
		await expect(assertBundledGrokCliDefaults()).resolves.toBeUndefined();
		expect(typeof getBundledGrokBuildExtensionFactory()).toBe("function");
		expect(getBundledGrokCliModelDefaults()).toContain("grok-composer-2.5-fast");
	});

	it("registers Grok 4.5 with verified model metadata and documented effort cap", async () => {
		const previousGrokCliModels = process.env.SKC_GROK_CLI_MODELS;
		delete process.env.SKC_GROK_CLI_MODELS;
		try {
			const model = resolveModels().find(candidate => candidate.id === "grok-4.5");

			expect(model).toEqual({
				id: "grok-4.5",
				name: "Grok 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 30_000,
				maxReasoningEffort: Effort.High,
			});
			expect(supportsReasoningEffort("grok-build/grok-4.5")).toBe(true);

			const providerConfig = await captureGrokBuildProviderConfig();
			const registeredModel = providerConfig?.models?.find(candidate => candidate.id === "grok-4.5");
			expect(registeredModel?.thinking).toEqual({
				minLevel: Effort.Low,
				maxLevel: Effort.High,
				mode: "effort",
			});
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.SKC_GROK_CLI_MODELS;
			} else {
				process.env.SKC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});

	it("registers Grok 4.6 with verified model metadata and documented xhigh effort cap", async () => {
		const previousGrokCliModels = process.env.SKC_GROK_CLI_MODELS;
		delete process.env.SKC_GROK_CLI_MODELS;
		try {
			const model = resolveModels().find(candidate => candidate.id === "grok-4.6");

			expect(model).toEqual({
				id: "grok-4.6",
				name: "Grok 4.6",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 30_000,
				maxReasoningEffort: Effort.XHigh,
			});
			expect(supportsReasoningEffort("grok-build/grok-4.6")).toBe(true);

			const providerConfig = await captureGrokBuildProviderConfig();
			const registeredModel = providerConfig?.models?.find(candidate => candidate.id === "grok-4.6");
			expect(registeredModel?.thinking).toEqual({
				minLevel: Effort.Low,
				maxLevel: Effort.XHigh,
				mode: "effort",
			});
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.SKC_GROK_CLI_MODELS;
			} else {
				process.env.SKC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});

	it("registers Grok 4.7 and Grok 4.7 Build Fast, first in the list, with xhigh effort", async () => {
		const previousGrokCliModels = process.env.SKC_GROK_CLI_MODELS;
		delete process.env.SKC_GROK_CLI_MODELS;
		try {
			const ids = resolveModels().map(model => model.id);
			expect(ids.slice(0, 2)).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
			for (const id of ["grok-4.7", "grok-4.7-build-fast"]) {
				expect(supportsReasoningEffort(`grok-build/${id}`)).toBe(true);
			}
			const providerConfig = await captureGrokBuildProviderConfig();
			for (const id of ["grok-4.7", "grok-4.7-build-fast"]) {
				const registered = providerConfig?.models?.find(candidate => candidate.id === id);
				expect(registered?.contextWindow).toBe(500_000);
				expect(registered?.thinking).toEqual({ minLevel: Effort.Low, maxLevel: Effort.XHigh, mode: "effort" });
			}
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.SKC_GROK_CLI_MODELS;
			} else {
				process.env.SKC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});

	it("maps official Grok 4.5 aliases to canonical metadata and effort limits", async () => {
		const previousGrokCliModels = process.env.SKC_GROK_CLI_MODELS;
		const aliases = ["grok-4.5-latest", "grok-build-latest"];
		process.env.SKC_GROK_CLI_MODELS = aliases.join(",");
		try {
			const expectedMetadata = {
				name: "Grok 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 30_000,
				maxReasoningEffort: Effort.High,
			} satisfies Omit<GrokCliModelConfig, "id">;
			expect(resolveModels()).toEqual(aliases.map(id => ({ id, ...expectedMetadata })));
			for (const alias of aliases) {
				expect(supportsReasoningEffort(`grok-build/${alias}`)).toBe(true);
			}

			const providerConfig = await captureGrokBuildProviderConfig();
			expect(
				providerConfig.models?.map(model => ({
					id: model.id,
					thinking: model.thinking,
				})),
			).toEqual(
				aliases.map(id => ({
					id,
					thinking: {
						minLevel: Effort.Low,
						maxLevel: Effort.High,
						mode: "effort",
					},
				})),
			);
		} finally {
			if (previousGrokCliModels === undefined) {
				delete process.env.SKC_GROK_CLI_MODELS;
			} else {
				process.env.SKC_GROK_CLI_MODELS = previousGrokCliModels;
			}
		}
	});
});
