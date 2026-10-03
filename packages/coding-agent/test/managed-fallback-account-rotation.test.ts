import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@sayknow-cli/agent-core";
import { type AssistantMessage, getBundledModel, type Message, type Model } from "@sayknow-cli/ai";
import { createMockModel } from "@sayknow-cli/ai/providers/mock";
import type { CredentialRankingStrategy, UsageProvider, UsageReport } from "@sayknow-cli/ai/usage";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import { classifyFallbackTrigger } from "@sayknow-cli/ai/utils/fallback-transport";
import * as oauth from "@sayknow-cli/ai/utils/oauth";
import { ModelRegistry } from "@sayknow-cli/coding-agent/config/model-registry";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";
import { AuthStorage } from "@sayknow-cli/coding-agent/session/auth-storage";
import { SessionManager } from "@sayknow-cli/coding-agent/session/session-manager";

const provider = "openai-codex";
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function usageLimitStream(model: Model): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
		timestamp: Date.now(),
		transportFailure: { kind: "transport", providerCode: "usage_limit_reached" },
	};
	expect(classifyFallbackTrigger(message.transportFailure).class).toBe("quota");
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
	});
	return stream;
}

const strategy: CredentialRankingStrategy = {
	findWindowLimits: report => ({ primary: report.limits[0] }),
	windowDefaults: { primaryMs: 3_600_000, secondaryMs: 86_400_000 },
};

async function run(opts: { accounts: string[]; quotaKeys: string[]; pinA?: boolean; firstFails?: boolean }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-rotation-repro-"));
	const usageProvider: UsageProvider = {
		id: provider,
		async fetchUsage(params): Promise<UsageReport | null> {
			const accountId = params.credential.accountId ?? "unknown";
			return {
				provider,
				fetchedAt: Date.now(),
				limits: [
					{
						id: "requests",
						label: "Requests",
						scope: { provider, accountId },
						amount: { unit: "requests", used: 10, limit: 100 },
						status: "ok",
					},
				],
			};
		},
	};
	const storage = await AuthStorage.create(path.join(root, "auth.db"), {
		usageProviderResolver: p => (p === provider ? usageProvider : undefined),
		rankingStrategyResolver: p => (p === provider ? strategy : undefined),
	});
	vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
		const credential = credentials[provider];
		return credential ? { apiKey: credential.access, newCredentials: credential } : null;
	});
	let session: AgentSession | undefined;
	try {
		await storage.set(
			provider,
			opts.accounts.map(accountId => ({
				type: "oauth" as const,
				access: `TOKEN-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 3_600_000,
				accountId,
			})),
		);
		if (opts.pinA) storage.setRuntimeCredentialSelector(provider, { kind: "account", value: "a" });
		storage.setRuntimeApiKey("openai", "fallback-test-key");
		const model = getBundledModel(provider, "gpt-5.1-codex");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!model || !fallback) throw new Error("fixtures");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"fallback.maxAttempts": 3,
			"fallback.auto": false,
			"retry.baseDelayMs": 1,
			"decisions.enabled": false,
		});
		settings.setModelRole("default", `${provider}/${model.id},openai/${fallback.id}`);
		const registry = new ModelRegistry(storage, path.join(root, "models.yml"));
		const success = createMockModel({ responses: [{ content: ["accepted"] }, { content: ["accepted"] }] });
		const dispatched: string[] = [];
		const keys: string[] = [];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Synthetic test"], tools: [], messages: [] },
			convertToLlm: identityConverter,
			getApiKey: async (p: string) => {
				if (!session) throw new Error("Session not initialized");
				return registry.getApiKeyForProvider(p, session.sessionId);
			},
			streamFn: (m, context, options) => {
				dispatched.push(`${m.provider}/${m.id}`);
				keys.push(String(options?.apiKey));
				if (opts.firstFails && keys.length === 1) opts.quotaKeys.push(String(options?.apiKey));
				if (opts.quotaKeys.includes(String(options?.apiKey))) return usageLimitStream(m);
				return success.stream(m, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		await session.prompt("go");
		await session.waitForIdle();
		return { dispatched, keys, model: `${provider}/${model.id}`, fallback: `openai/${fallback.id}` };
	} finally {
		await session?.dispose();
		vi.restoreAllMocks();
		storage.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("managed fallback rotates same-provider accounts before switching model", () => {
	test("one exhausted account: the same model continues on the other account", async () => {
		const r = await run({ accounts: ["a", "b"], quotaKeys: [], firstFails: true });
		expect(r.keys).toHaveLength(2);
		expect(r.keys[1]).not.toBe(r.keys[0]);
		expect(r.dispatched).toEqual([r.model, r.model]);
	});

	test("every account exhausted: each is tried once, then the next model — no repeat on a dead account", async () => {
		const r = await run({ accounts: ["a", "b"], quotaKeys: ["TOKEN-a", "TOKEN-b"] });
		expect(r.keys.slice(0, 2).sort()).toEqual(["TOKEN-a", "TOKEN-b"]);
		expect(r.keys.slice(2)).toEqual(["fallback-test-key"]);
		expect(r.dispatched.at(-1)).toBe(r.fallback);
	});

	test("reaches a fresh account behind several exhausted ones", async () => {
		const r = await run({ accounts: ["a", "b", "c", "d"], quotaKeys: ["TOKEN-a", "TOKEN-b", "TOKEN-c"] });
		expect(r.keys.at(-1)).toBe("TOKEN-d");
		expect(new Set(r.keys).size).toBe(r.keys.length);
	});

	test("a single exhausted account switches to the next model at once", async () => {
		const r = await run({ accounts: ["a"], quotaKeys: ["TOKEN-a"] });
		// Exhausted quota is not retried on the same dead account.
		expect(r.keys).toEqual(["TOKEN-a", "fallback-test-key"]);
		expect(r.dispatched).toEqual([r.model, r.fallback]);
	});

	test("an account pinned with --credential is not rotated away", async () => {
		const r = await run({ accounts: ["a", "b"], quotaKeys: ["TOKEN-a"], pinA: true });
		expect(r.keys.filter(key => key === "TOKEN-b")).toEqual([]);
	});
});
