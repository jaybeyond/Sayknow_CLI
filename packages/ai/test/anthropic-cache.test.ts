import { describe, expect, it } from "bun:test";
import type { CacheControlEphemeral, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import {
	applyPromptCaching,
	normalizeCacheControlTtlOrdering,
	streamAnthropic,
} from "@sayknow-cli/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@sayknow-cli/ai/types";

const canonicalModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

type CacheControl = { type: string; ttl?: string };
type Payload = MessageCreateParamsStreaming & { cache_control?: CacheControl };

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function context(messages: Context["messages"] = [{ role: "user", content: "Continue", timestamp: 1 }]): Context {
	return {
		systemPrompt: ["Stable instructions", "Second stable instruction"],
		tools: [
			{
				name: "lookup",
				description: "Looks up an answer.",
				parameters: { type: "object", properties: {} } as TJsonSchema,
			},
		],
		messages,
	};
}

function capturePayload(
	model: Model<"anthropic-messages">,
	input: Context,
	onPayload?: (payload: Payload) => Payload | undefined,
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, input, {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: abortedSignal(),
		onPayload: payload => {
			const replacement = onPayload?.(payload as Payload);
			resolve((replacement ?? payload) as Payload);
			return replacement;
		},
	});
	return promise;
}

function cacheParams(overrides: Partial<Payload> = {}): Payload {
	return {
		model: canonicalModel.id,
		max_tokens: 1,
		stream: true,
		messages: [{ role: "user", content: [{ type: "text", text: "Continue" }] }],
		...overrides,
	};
}

function cacheControls(payload: Payload): CacheControl[] {
	const controls: CacheControl[] = [];
	if (payload.cache_control) controls.push(payload.cache_control);
	for (const tool of payload.tools ?? []) {
		const control = (tool as { cache_control?: CacheControl }).cache_control;
		if (control) controls.push(control);
	}
	if (Array.isArray(payload.system)) {
		for (const block of payload.system) {
			const control = (block as { cache_control?: CacheControl }).cache_control;
			if (control) controls.push(control);
		}
	}
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const control = (block as { cache_control?: CacheControl }).cache_control;
			if (control) controls.push(control);
		}
	}
	return controls;
}

describe("Anthropic prompt caching", () => {
	const explicitCompatibleModel: Model<"anthropic-messages"> = {
		...canonicalModel,
		baseUrl: "https://proxy.example.test/anthropic",
		compat: { promptCacheMode: "explicit" },
	};

	it("defaults canonical Anthropic to automatic and requires compatible endpoints to opt into explicit caching", async () => {
		const [canonical, compatible, explicit] = await Promise.all([
			capturePayload(canonicalModel, context()),
			capturePayload({ ...canonicalModel, baseUrl: "https://proxy.example.test/anthropic" }, context()),
			capturePayload(explicitCompatibleModel, context()),
		]);

		expect(canonical.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(compatible.cache_control).toBeUndefined();
		expect(explicit.cache_control).toBeUndefined();
		expect(explicit.tools?.every(tool => !(tool as { cache_control?: CacheControl }).cache_control)).toBe(true);
		expect(!Array.isArray(explicit.system) || explicit.system.every(block => !block.cache_control)).toBe(true);
		expect((explicit.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>)[0]?.cache_control).toEqual({
			type: "ephemeral",
		});
	});

	for (const callerMarkerCount of [3, 4]) {
		it(`respects ${callerMarkerCount} caller markers in automatic mode`, () => {
			const params = cacheParams({
				tools: [
					{
						name: "lookup",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral" },
					},
				],
				system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
				messages: [
					{
						role: "user",
						content: Array.from({ length: callerMarkerCount - 2 }, (_, index) => ({
							type: "text" as const,
							text: `question ${index}`,
							cache_control: { type: "ephemeral" as const },
						})),
					},
				],
			});
			const before = structuredClone(params);

			applyPromptCaching(params, "automatic", { type: "ephemeral" });

			if (callerMarkerCount === 4) {
				expect(params.cache_control).toBeUndefined();
				expect(params).toEqual(before);
			} else {
				expect(params.cache_control).toEqual({ type: "ephemeral" });
				expect(params).toEqual({ ...before, cache_control: { type: "ephemeral" } });
			}
			expect(cacheControls(params)).toHaveLength(4);
			expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
		});
	}

	it("still replaces an existing root marker in automatic mode", () => {
		const params = cacheParams({ cache_control: { type: "ephemeral" } });

		applyPromptCaching(params, "automatic", { type: "ephemeral", ttl: "1h" });

		expect(params.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	describe("generated automatic root-marker layouts", () => {
		const seededRandom = (seed: number): (() => number) => {
			let state = seed >>> 0;
			return () => {
				state = (state + 0x6d2b79f5) >>> 0;
				let value = Math.imul(state ^ (state >>> 15), state | 1);
				value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
				return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
			};
		};
		const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const withoutRoot = (payload: Payload): Payload => {
			const { cache_control: _root, ...rest } = payload;
			return rest as Payload;
		};

		for (let seed = 0; seed < 500; seed++) {
			it(`keeps caller markers and the four-breakpoint cap for seed ${seed}`, () => {
				const random = seededRandom(seed);
				// One TTL for every marker so each layout satisfies the long-before-short ordering rule.
				const control: CacheControlEphemeral = { type: "ephemeral" };
				const ttl = pick(random, [undefined, "5m", "1h"] as const);
				if (ttl) control.ttl = ttl;
				const params = cacheParams({
					tools: Array.from({ length: pick(random, [0, 1, 2, 3]) }, (_, index) => ({
						name: `tool_${index}`,
						input_schema: { type: "object" as const },
					})),
					system: Array.from({ length: pick(random, [0, 1, 2, 3]) }, (_, index) => ({
						type: "text" as const,
						text: `System ${index}`,
					})),
					messages: Array.from({ length: pick(random, [1, 2, 3]) }, (_, index) => ({
						role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
						content: Array.from({ length: pick(random, [1, 2]) }, (_, block) => ({
							type: "text" as const,
							text: `Message ${index}.${block}`,
						})),
					})),
				});
				const slots: Array<{ cache_control?: CacheControl | null }> = [
					params,
					...(params.tools ?? []),
					...(Array.isArray(params.system) ? params.system : []),
					...params.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])),
				] as Array<{ cache_control?: CacheControl | null }>;
				for (let index = slots.length - 1; index > 0; index--) {
					const other = Math.floor(random() * (index + 1));
					[slots[index], slots[other]] = [slots[other]!, slots[index]!];
				}
				for (const slot of slots.slice(0, pick(random, [0, 1, 2, 3, 4]))) slot.cache_control = { ...control };
				const before = structuredClone(params);
				const countBefore = cacheControls(before).length;
				const rootBefore = params.cache_control;

				// The fork has no generated-marker budget: it always behaves like upstream budget >= 2.
				applyPromptCaching(params, "automatic", { ...control });

				// The root marker is replaced or added only while it fits the cap; then the last system
				// block gains one only when no system block had one and the cap still has room.
				const rootAfter = before.cache_control || countBefore < 4;
				const countAfterRoot = countBefore + (before.cache_control || !rootAfter ? 0 : 1);
				const systemBefore = Array.isArray(before.system) ? before.system : [];
				const systemAdds =
					systemBefore.length > 0 && !systemBefore.some(block => block.cache_control) && countAfterRoot < 4;
				const expected = withoutRoot(before);
				if (systemAdds && Array.isArray(expected.system)) expected.system.at(-1)!.cache_control = control;
				expect(withoutRoot(params)).toEqual(expected);
				if (before.cache_control) {
					// replaced by a fresh marker, even when the caller's root already had the same value
					expect(params.cache_control).not.toBe(rootBefore);
					expect(params.cache_control).toEqual(control);
				} else if (rootAfter) {
					expect(params.cache_control).toEqual(control);
				} else {
					expect(params.cache_control).toBeUndefined();
				}
				expect(cacheControls(params)).toHaveLength(countAfterRoot + (systemAdds ? 1 : 0));
				expect(cacheControls(params).length).toBeLessThanOrEqual(4);
				expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
			});
		}
	});

	it("counts top-level automatic and caller controls together without mutating a callback replacement", async () => {
		const replacement = cacheParams({
			cache_control: { type: "ephemeral", ttl: "1h" },
			tools: [
				{
					name: "first",
					description: "first",
					input_schema: { type: "object", properties: {} },
					cache_control: { type: "ephemeral", ttl: "1h" },
				},
			],
			system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "current question", cache_control: { type: "ephemeral" } }],
				},
			],
		});
		const before = structuredClone(replacement);
		const payload = await capturePayload(canonicalModel, context(), () => replacement);

		expect(payload).toBe(replacement);
		expect(replacement).toEqual(before);
		expect(cacheControls(payload)).toHaveLength(4);
	});

	it("accepts zero, one, and four ordered caller controls across tools, system, and messages", () => {
		const cases: Payload[] = [
			cacheParams(),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
			}),
			cacheParams({
				tools: [
					{
						name: "tool",
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral", ttl: "1h" },
					},
				],
				system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "stable answer", cache_control: { type: "ephemeral" } }],
					},
					{
						role: "user",
						content: [{ type: "text", text: "current question", cache_control: { type: "ephemeral" } }],
					},
				],
			}),
		];
		for (const params of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
			expect(params).toEqual(before);
		}
	});

	it("accepts nullable cache controls as absent without mutation", () => {
		const params = cacheParams({
			cache_control: null,
			tools: [
				{
					name: "tool",
					description: "tool",
					input_schema: { type: "object", properties: {} },
					cache_control: null,
				},
			],
			system: [{ type: "text", text: "stable", cache_control: null }],
			messages: [{ role: "user", content: [{ type: "text", text: "question", cache_control: null }] }],
		} as Payload);
		const before = structuredClone(params);

		expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
		expect(params).toEqual(before);
		expect(cacheControls(params)).toHaveLength(0);
	});

	it("fails closed for invalid callback controls and never normalizes caller objects", () => {
		const cases: Array<{ name: string; params: Payload }> = [
			{
				name: "five controls",
				params: cacheParams({
					cache_control: { type: "ephemeral" },
					tools: Array.from({ length: 4 }, (_, index) => ({
						name: `tool-${index}`,
						description: "tool",
						input_schema: { type: "object", properties: {} },
						cache_control: { type: "ephemeral" },
					})),
				}),
			},
			{
				name: "five-minute before one-hour",
				params: cacheParams({
					system: [{ type: "text", text: "short", cache_control: { type: "ephemeral" } }],
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: "long", cache_control: { type: "ephemeral", ttl: "1h" } }],
						},
					],
				}),
			},
			{
				name: "thinking target",
				params: {
					...cacheParams(),
					messages: [
						{
							role: "assistant",
							content: [
								{
									type: "thinking",
									thinking: "private",
									signature: "sig",
									cache_control: { type: "ephemeral" },
								},
							],
						},
					],
				} as unknown as Payload,
			},
			{
				name: "empty text target",
				params: cacheParams({
					messages: [
						{ role: "user", content: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }] },
					],
				}),
			},
		];
		for (const { name, params } of cases) {
			const before = structuredClone(params);
			expect(() => normalizeCacheControlTtlOrdering(params)).toThrow(`Invalid Anthropic cache_control`);
			expect(params, name).toEqual(before);
		}
	});

	it("refreshes only the current explicit candidate at history deltas 19 and 20", async () => {
		for (const historyLength of [19, 20]) {
			const payload = await capturePayload(
				explicitCompatibleModel,
				context([
					...Array.from({ length: historyLength }, (_, index) => ({
						role: "user" as const,
						content: `history ${index}`,
						timestamp: index + 1,
					})),
					{ role: "user", content: "refresh", timestamp: historyLength + 1 },
				]),
			);
			const historicalBlocks = payload.messages
				.slice(0, -1)
				.flatMap(message => (Array.isArray(message.content) ? message.content : [])) as Array<{
				cache_control?: CacheControl;
			}>;
			const currentBlocks = payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>;
			expect(historicalBlocks.some(block => block.cache_control)).toBe(false);
			expect(currentBlocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		}
	});

	it("uses the final mixed tool_result/text user content as the explicit refresh point", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "Answer" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "Use the answer", timestamp: 3 },
			]),
		);
		expect(
			(payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>).at(-1)?.cache_control,
		).toEqual({
			type: "ephemeral",
		});
	});

	it("does not treat a tool-result-only wire user turn as the explicit human refresh", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: canonicalModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "Answer" }],
					isError: false,
					timestamp: 3,
				},
			]),
		);
		const firstUserContent = payload.messages[0]?.content as Array<{ cache_control?: CacheControl }>;
		const toolResultContent = payload.messages.at(-1)?.content as Array<{ cache_control?: CacheControl }>;

		expect(firstUserContent.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(toolResultContent.some(block => block.cache_control)).toBe(false);
	});

	it("keeps explicit markers off tools, system/schema, and thinking blocks", async () => {
		const payload = await capturePayload(
			explicitCompatibleModel,
			context([
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "private", thinkingSignature: "sig" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: canonicalModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "", timestamp: 2 },
			]),
		);
		expect(payload.tools?.[0]).toMatchObject({ input_schema: { type: "object", properties: {} } });
		expect(payload.tools?.some(tool => (tool as { cache_control?: CacheControl }).cache_control)).toBe(false);
		expect(Array.isArray(payload.system) && payload.system.some(block => block.cache_control)).toBe(false);
		expect(cacheControls(payload)).toEqual([{ type: "ephemeral" }]);
		expect(payload.messages.at(-1)?.content).toEqual([
			{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } },
		]);
	});
});

describe("Anthropic automatic cache system anchor (gajae #6913)", () => {
	it("anchors the last system block next to the canonical root marker", async () => {
		const payload = await capturePayload(canonicalModel, context());
		expect(payload.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payload.system).toEqual([
			{ type: "text", text: "Stable instructions" },
			{ type: "text", text: "Second stable instruction", cache_control: payload.cache_control },
		]);
	});

	it("does not add a system marker when automatic caching has no system blocks", async () => {
		const payload = await capturePayload(canonicalModel, { ...context(), systemPrompt: undefined });
		expect(payload.system).toBeUndefined();
		expect(cacheControls(payload)).toEqual([{ type: "ephemeral", ttl: "1h" }]);
	});

	it("preserves an existing system breakpoint without adding another", () => {
		const params = cacheParams({
			system: [
				{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
				{ type: "text", text: "tail" },
			],
		});
		applyPromptCaching(params, "automatic", { type: "ephemeral", ttl: "1h" });
		expect(params.system).toEqual([
			{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
			{ type: "text", text: "tail" },
		]);
		expect(cacheControls(params)).toHaveLength(2);
		normalizeCacheControlTtlOrdering(params);
	});

	it("keeps the automatic root and system markers within the four-breakpoint cap", () => {
		for (const existingCount of [0, 2, 3, 4]) {
			const params = cacheParams({
				system: [{ type: "text", text: "stable" }],
				tools: Array.from({ length: existingCount }, (_, index) => ({
					name: `tool_${index}`,
					input_schema: { type: "object" as const },
					cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
				})),
			});
			applyPromptCaching(params, "automatic", { type: "ephemeral", ttl: "1h" });
			const hasRoot = existingCount < 4;
			const hasSystemMarker = existingCount + Number(hasRoot) < 4;
			expect(params.cache_control !== undefined).toBe(hasRoot);
			expect(params.system).toEqual([
				{
					type: "text",
					text: "stable",
					...(hasSystemMarker ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}),
				},
			]);
			expect(cacheControls(params)).toHaveLength(existingCount + Number(hasRoot) + Number(hasSystemMarker));
			normalizeCacheControlTtlOrdering(params);
		}
	});

	describe("generated automatic root-marker layouts", () => {
		const seededRandom = (seed: number): (() => number) => {
			let state = seed >>> 0;
			return () => {
				state = (state + 0x6d2b79f5) >>> 0;
				let value = Math.imul(state ^ (state >>> 15), state | 1);
				value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
				return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
			};
		};
		const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const withoutRoot = (payload: Payload): Payload => {
			const { cache_control: _root, ...rest } = payload;
			return rest as Payload;
		};

		for (let seed = 0; seed < 500; seed++) {
			it(`keeps caller markers and the four-breakpoint cap for seed ${seed}`, () => {
				const random = seededRandom(seed);
				// One TTL for every marker so each layout satisfies the long-before-short ordering rule.
				const control: CacheControlEphemeral = { type: "ephemeral" };
				const ttl = pick(random, [undefined, "5m", "1h"] as const);
				if (ttl) control.ttl = ttl;
				const params = cacheParams({
					tools: Array.from({ length: pick(random, [0, 1, 2, 3]) }, (_, index) => ({
						name: `tool_${index}`,
						input_schema: { type: "object" as const },
					})),
					system: Array.from({ length: pick(random, [0, 1, 2, 3]) }, (_, index) => ({
						type: "text" as const,
						text: `System ${index}`,
					})),
					messages: Array.from({ length: pick(random, [1, 2, 3]) }, (_, index) => ({
						role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
						content: Array.from({ length: pick(random, [1, 2]) }, (_, block) => ({
							type: "text" as const,
							text: `Message ${index}.${block}`,
						})),
					})),
				});
				const slots: Array<{ cache_control?: CacheControl | null }> = [
					params,
					...(params.tools ?? []),
					...(Array.isArray(params.system) ? params.system : []),
					...params.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])),
				] as Array<{ cache_control?: CacheControl | null }>;
				for (let index = slots.length - 1; index > 0; index--) {
					const other = Math.floor(random() * (index + 1));
					[slots[index], slots[other]] = [slots[other]!, slots[index]!];
				}
				for (const slot of slots.slice(0, pick(random, [0, 1, 2, 3, 4]))) slot.cache_control = { ...control };
				const before = structuredClone(params);
				const countBefore = cacheControls(before).length;
				const rootBefore = params.cache_control;

				applyPromptCaching(params, "automatic", { ...control });

				// The root marker is replaced or added only while it fits the cap; then the last system
				// block gains one only when no system block had one and the cap still has room.
				const rootAfter = before.cache_control !== undefined || countBefore < 4;
				const countAfterRoot = countBefore + (before.cache_control || !rootAfter ? 0 : 1);
				const systemBefore = Array.isArray(before.system) ? before.system : [];
				const systemAdds =
					systemBefore.length > 0 && !systemBefore.some(block => block.cache_control) && countAfterRoot < 4;
				const expected = withoutRoot(before);
				if (systemAdds && Array.isArray(expected.system)) expected.system.at(-1)!.cache_control = control;
				expect(withoutRoot(params)).toEqual(expected);
				if (before.cache_control) {
					// replaced by a fresh marker, even when the caller's root already had the same value
					expect(params.cache_control).not.toBe(rootBefore);
					expect(params.cache_control).toEqual(control);
				} else if (rootAfter) {
					expect(params.cache_control).toEqual(control);
				} else {
					expect(params.cache_control).toBeUndefined();
				}
				expect(cacheControls(params)).toHaveLength(countAfterRoot + (systemAdds ? 1 : 0));
				expect(cacheControls(params).length).toBeLessThanOrEqual(4);
				expect(() => normalizeCacheControlTtlOrdering(params)).not.toThrow();
			});
		}
	});
});
