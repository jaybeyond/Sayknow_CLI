/**
 * Regression coverage for the web_search latency work:
 *
 * 1. Per-class hard timeouts — pure search APIs get a short ceiling
 *    (SEARCH_API_TIMEOUT_MS) and LLM-mediated providers a medium one
 *    (SEARCH_LLM_TIMEOUT_MS), replacing the uniform 300s ceiling. The
 *    user-configured `web_search.timeout` still overrides class defaults,
 *    while explicit millisecond arguments always win.
 * 2. Resolved-chain caching — resolveProviderChain memoizes the resolved
 *    provider-id list per AuthStorage instance so repeated searches skip
 *    credential availability probes; settings changes clear the cache.
 * 3. Hedged DuckDuckGo fallback — when DDG is a non-primary chain member,
 *    executeSearch fires it in the background after a short delay so a
 *    slow-failing primary falls back to an already-settled result, and
 *    aborts the hedge when the primary wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@sayknow-cli/ai";
import type { ToolSession } from "../../../src/tools";
import { setDdgHedgeDelayMs, WebSearchTool } from "../../../src/web/search";
import * as provider from "../../../src/web/search/provider";
import {
	clearResolvedChainCache,
	resolveProviderChain,
	setPreferredSearchProvider,
	setSearchFallbackProviders,
} from "../../../src/web/search/provider";
import type { SearchParams } from "../../../src/web/search/providers/base";
import {
	applyConfiguredSearchTimeout,
	SEARCH_API_TIMEOUT_MS,
	SEARCH_HARD_TIMEOUT_MS,
	SEARCH_LLM_TIMEOUT_MS,
	setSearchHardTimeoutMs,
	withHardTimeout,
} from "../../../src/web/search/providers/utils";
import type { SearchProviderId, SearchResponse } from "../../../src/web/search/types";

const FAKE_SESSION = {} as ToolSession;

describe("per-class hard timeouts", () => {
	afterEach(() => setSearchHardTimeoutMs(undefined));

	it("orders the class ceilings sensibly: api < llm <= legacy", () => {
		expect(SEARCH_API_TIMEOUT_MS).toBeLessThan(SEARCH_LLM_TIMEOUT_MS);
		expect(SEARCH_LLM_TIMEOUT_MS).toBeLessThanOrEqual(SEARCH_HARD_TIMEOUT_MS);
	});

	it("applies the user override to class-tagged calls", async () => {
		setSearchHardTimeoutMs(10);
		const apiSignal = withHardTimeout(undefined, "api");
		const llmSignal = withHardTimeout(undefined, "llm");
		await Bun.sleep(50);
		expect(apiSignal.aborted).toBe(true);
		expect(llmSignal.aborted).toBe(true);
	});

	it("lets an explicit millisecond argument win over the user override", async () => {
		setSearchHardTimeoutMs(60_000);
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(50);
		expect(signal.aborted).toBe(true);
	});

	it("does not abort a class-tagged signal immediately without an override", async () => {
		const signal = withHardTimeout(undefined, "api");
		await Bun.sleep(30);
		expect(signal.aborted).toBe(false);
	});
});

describe("applyConfiguredSearchTimeout (settings initialization path)", () => {
	afterEach(() => setSearchHardTimeoutMs(undefined));

	function settingsSource(explicit: boolean, value: unknown) {
		return {
			get: () => value as number,
			has: () => explicit,
		};
	}

	it("does NOT install the schema default as a global override", async () => {
		// Regression for the review blocker: settings.get("web_search.timeout")
		// returns the schema default (300) even when the user never configured
		// it. Consuming that value unconditionally would reinstall the uniform
		// 300s ceiling and kill the per-class defaults on every real session.
		applyConfiguredSearchTimeout(settingsSource(false, 300));
		const signal = withHardTimeout(undefined, "api");
		await Bun.sleep(30);
		// Un-overridden api-class signals must stay open well past any
		// wrongly-installed millisecond-scale override.
		expect(signal.aborted).toBe(false);
	});

	it("installs an explicitly configured timeout as the override", async () => {
		applyConfiguredSearchTimeout(settingsSource(true, 0.01)); // 10ms
		const apiSignal = withHardTimeout(undefined, "api");
		const llmSignal = withHardTimeout(undefined, "llm");
		await Bun.sleep(50);
		expect(apiSignal.aborted).toBe(true);
		expect(llmSignal.aborted).toBe(true);
	});

	it("clears a previous override when the setting is no longer explicitly configured", async () => {
		applyConfiguredSearchTimeout(settingsSource(true, 0.01));
		applyConfiguredSearchTimeout(settingsSource(false, 300));
		const signal = withHardTimeout(undefined, "api");
		await Bun.sleep(30);
		expect(signal.aborted).toBe(false);
	});

	it("ignores invalid explicit values instead of installing them", async () => {
		applyConfiguredSearchTimeout(settingsSource(true, -5));
		const signal = withHardTimeout(undefined, "api");
		await Bun.sleep(30);
		expect(signal.aborted).toBe(false);
	});
});

describe("resolved-chain caching", () => {
	beforeEach(() => {
		// Pin module-global selection state: other test files leave a preferred
		// provider / fallback list behind, which would bypass the auto path.
		setPreferredSearchProvider("auto");
		setSearchFallbackProviders([]);
		clearResolvedChainCache();
	});

	function countingAuth() {
		let probes = 0;
		const storage = {
			hasAuth: () => false,
			hasOAuth: () => false,
			getOAuthAccess: () => undefined,
			getApiKey: async () => {
				probes++;
				return "sk-test";
			},
		} as unknown as AuthStorage;
		return { storage, probeCount: () => probes };
	}

	const ctx = {
		provider: "my-proxy",
		modelId: "gpt-5.2",
		api: "openai-responses",
		baseUrl: "https://llm.example.com/v1",
	} as const;

	it("skips availability probes on a repeat resolution with the same storage and context", async () => {
		const { storage, probeCount } = countingAuth();
		const first = await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		const probesAfterFirst = probeCount();
		expect(probesAfterFirst).toBeGreaterThan(0);

		const second = await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		expect(probeCount()).toBe(probesAfterFirst);
		expect(second.map(p => p.id)).toEqual(first.map(p => p.id));
	});

	it("re-probes after clearResolvedChainCache", async () => {
		const { storage, probeCount } = countingAuth();
		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		const probesAfterFirst = probeCount();
		clearResolvedChainCache();
		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		expect(probeCount()).toBeGreaterThan(probesAfterFirst);
	});

	it("does not share cache entries across different AuthStorage instances", async () => {
		const a = countingAuth();
		const b = countingAuth();
		await resolveProviderChain({ authStorage: a.storage, activeModelContext: { ...ctx } });
		await resolveProviderChain({ authStorage: b.storage, activeModelContext: { ...ctx } });
		expect(b.probeCount()).toBeGreaterThan(0);
	});

	it("invalidates cached chains when the AuthStorage generation changes", async () => {
		let probes = 0;
		let generation = 1;
		const storage = {
			hasAuth: () => false,
			hasOAuth: () => false,
			getOAuthAccess: () => undefined,
			getGeneration: () => generation,
			getApiKey: async () => {
				probes++;
				return "sk-test";
			},
		} as unknown as AuthStorage;

		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		const probesAfterFirst = probes;
		// Same generation: cache hit, no new probes.
		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		expect(probes).toBe(probesAfterFirst);
		// Credential change (login/logout) bumps the generation: re-probe.
		generation = 2;
		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		expect(probes).toBeGreaterThan(probesAfterFirst);
	});

	it("does not share cache entries across different model contexts", async () => {
		const { storage, probeCount } = countingAuth();
		await resolveProviderChain({ authStorage: storage, activeModelContext: { ...ctx } });
		const probesAfterFirst = probeCount();
		await resolveProviderChain({
			authStorage: storage,
			activeModelContext: { ...ctx, modelId: "other-model" },
		});
		expect(probeCount()).toBeGreaterThan(probesAfterFirst);
	});
});

describe("hedged DuckDuckGo fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setDdgHedgeDelayMs(undefined);
	});

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return { id, label: id, isAvailable: () => true, search: behaviour };
	}

	const ddgResponse: SearchResponse = {
		provider: "duckduckgo",
		sources: [{ title: "hit", url: "https://example.com", ageSeconds: undefined }],
	};

	it("reuses the in-flight hedge when the primary fails after the hedge fired", async () => {
		setDdgHedgeDelayMs(30);
		let ddgCalledAt = 0;
		let primarySettledAt = 0;
		let ddgCalls = 0;
		const t0 = performance.now();

		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("searxng", async () => {
				await Bun.sleep(120);
				primarySettledAt = performance.now() - t0;
				throw new Error("primary hung then failed");
			}),
			fakeProvider("duckduckgo", async () => {
				ddgCalls++;
				ddgCalledAt = performance.now() - t0;
				await Bun.sleep(10);
				return ddgResponse;
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("t", { query: "q" });

		expect(ddgCalls).toBe(1);
		// The hedge started while the primary was still in flight.
		expect(ddgCalledAt).toBeLessThan(primarySettledAt);
		expect(result.details?.response.provider).toBe("duckduckgo");
		const block = result.content[0];
		expect(block && "text" in block ? block.text : "").toContain("Warning: Web search provider fallback");
	});

	it("aborts the hedge when the primary succeeds", async () => {
		setDdgHedgeDelayMs(20);
		let hedgeSignal: AbortSignal | undefined;

		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("searxng", async () => {
				await Bun.sleep(80);
				return { provider: "searxng", sources: [] };
			}),
			fakeProvider("duckduckgo", async params => {
				hedgeSignal = params.signal;
				await Bun.sleep(1_000);
				return ddgResponse;
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("t", { query: "q" });

		expect(result.details?.response.provider).toBe("searxng");
		// The hedge was started (delay elapsed before primary success) and
		// then aborted once the primary won.
		expect(hedgeSignal).toBeInstanceOf(AbortSignal);
		expect(hedgeSignal?.aborted).toBe(true);
	});

	it("does not double-invoke DuckDuckGo when the primary fails before the hedge fires", async () => {
		setDdgHedgeDelayMs(5_000);
		let ddgCalls = 0;

		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("searxng", async () => {
				throw new Error("fast failure");
			}),
			fakeProvider("duckduckgo", async () => {
				ddgCalls++;
				return ddgResponse;
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("t", { query: "q" });

		expect(ddgCalls).toBe(1);
		expect(result.details?.response.provider).toBe("duckduckgo");
	});

	it("runs DuckDuckGo directly with no hedge when it is the only provider", async () => {
		setDdgHedgeDelayMs(20);
		let ddgCalls = 0;

		vi.spyOn(provider, "resolveProviderChain").mockResolvedValue([
			fakeProvider("duckduckgo", async () => {
				ddgCalls++;
				return ddgResponse;
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("t", { query: "q" });
		// Give a would-be hedge timer time to fire if one was wrongly armed.
		await Bun.sleep(50);

		expect(ddgCalls).toBe(1);
		expect(result.details?.response.provider).toBe("duckduckgo");
	});
});
