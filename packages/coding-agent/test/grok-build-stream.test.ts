import { describe, expect, it, spyOn } from "bun:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@sayknow-cli/ai";
import * as openaiResponses from "@sayknow-cli/ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@sayknow-cli/ai/utils/event-stream";
import grokCliModelDefaults from "../src/defaults/skc/agent.models.grok-cli.yml" with { type: "text" };
import { GROK_CLI_VERSION, streamGrokCli } from "../src/defaults/skc/extensions/grok-cli-vendor/src/provider/stream";

describe("Grok Build stream wrapper", () => {
	it("forwards requests through OpenAI responses with Grok Build headers", () => {
		const captured: { model?: Model<Api>; options?: unknown } = {};
		const spy = spyOn(openaiResponses, "streamOpenAIResponses").mockImplementation((model, _context, options) => {
			captured.model = model as Model<Api>;
			captured.options = options as unknown;
			return new AssistantMessageEventStream();
		});
		try {
			const model = {
				provider: "grok-build",
				id: "grok-composer-2.5-fast",
				api: "grok-cli-responses",
			} as Model<Api>;
			const context = { messages: [], systemPrompt: [] } as unknown as Context;

			const stream = streamGrokCli(model, context, {
				sessionId: "session-123",
				headers: { "x-test": "ok", "x-grok-client-version": "0.2.33" },
			} as SimpleStreamOptions);

			expect(stream).toBeInstanceOf(AssistantMessageEventStream);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(captured.model?.provider).toBe("grok-build");
			expect(captured.model?.id).toBe("grok-composer-2.5-fast");
			expect(captured.model?.api).toBe("openai-responses");
			expect((captured.options as { headers?: Record<string, string> } | undefined)?.headers).toMatchObject({
				"x-test": "ok",
				"x-grok-client-identifier": "skc-grok-cli",
				// A stale caller/configured version never reaches the proxy (HTTP 426).
				"x-grok-client-version": "1.0.13",
				"x-grok-conv-id": "session-123",
				"x-grok-model-override": "grok-composer-2.5-fast",
				"x-xai-token-auth": "xai-grok-cli",
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the bundled models.yml client version in sync with the stream wrapper", () => {
		expect(GROK_CLI_VERSION).toBe("1.0.13");
		expect(grokCliModelDefaults).toContain(`x-grok-client-version: ${GROK_CLI_VERSION}`);
		expect(grokCliModelDefaults).not.toContain("0.2.33");
	});
});
