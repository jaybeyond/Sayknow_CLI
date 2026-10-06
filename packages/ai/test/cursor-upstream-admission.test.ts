import { afterEach, describe, expect, it, vi } from "bun:test";
import http2 from "node:http2";
import { streamCursor } from "../src/providers/cursor";
import type { Context, Model } from "../src/types";

const model: Model<"cursor-agent"> = {
	id: "cursor-test",
	name: "Cursor Test",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://cursor.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: ["Test"],
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("Cursor upstream admission", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("admits the agent run once, then marks it uncertain before dispatch", async () => {
		const order: string[] = [];
		vi.spyOn(http2, "connect").mockImplementation(() => {
			order.push("connect");
			throw new Error("connection refused");
		});
		const result = await streamCursor(model, context, {
			apiKey: "cursor-test-token",
			onUncertainUpstream: reason => order.push(`uncertain:${reason}`),
			onUpstreamRequest: kind => order.push(`admit:${kind}`),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(order).toEqual([
			"admit:inference",
			"uncertain:Cursor agent run has unobserved remote requests and effects",
			"connect",
		]);
	});

	it("does not connect when admission is refused", async () => {
		const connect = vi.spyOn(http2, "connect");
		const result = await streamCursor(model, context, {
			apiKey: "cursor-test-token",
			onUpstreamRequest: () => {
				throw new Error("Recovery request limit reached");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Recovery request limit reached");
		expect(connect).not.toHaveBeenCalled();
	});
});
