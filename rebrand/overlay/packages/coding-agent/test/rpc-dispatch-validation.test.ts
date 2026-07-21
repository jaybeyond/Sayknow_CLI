import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@sayknow-cli/agent-core";
import type { RpcCommand } from "@sayknow-cli/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@sayknow-cli/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@sayknow-cli/coding-agent/modes/shared/agent-wire/command-validation";
import type { AgentSession } from "@sayknow-cli/coding-agent/session/agent-session";

function ctx(session: Partial<AgentSession> = {}): RpcCommandDispatchContext {
	return {
		session: session as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

describe("dispatchRpcCommand validation + error correlation", () => {
	test.each([
		[
			"missing provider",
			{ id: "selection-missing-provider", type: "set_default_model_selection", modelId: "gpt-5" },
			"provider must be a non-empty string",
		],
		[
			"numeric modelId",
			{ id: "selection-numeric-model", type: "set_default_model_selection", provider: "openai", modelId: 42 },
			"modelId must be a non-empty string",
		],
		[
			"blank provider",
			{ id: "selection-blank-provider", type: "set_default_model_selection", provider: "  ", modelId: "gpt-5" },
			"provider must be a non-empty string",
		],
		[
			"invalid thinking level",
			{
				id: "selection-invalid-level",
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "extreme",
			},
			"thinkingLevel must be a concrete level",
		],
		[
			"inherited thinking level",
			{
				id: "selection-inherit-level",
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: ThinkingLevel.Inherit,
			},
			"thinkingLevel must be a concrete level",
		],
	] as const)("rejects a directly dispatched %s selector with correlated command identity", async (_name, frame, error) => {
		// Given: an untrusted selector that bypassed the public wire validator.
		const command = frame as unknown as RpcCommand;

		// When: the malformed command reaches the dispatcher directly.
		const response = await dispatchRpcCommand(command, ctx());

		// Then: the real command and request id are retained rather than being mislabeled as parse.
		expect(response).toMatchObject({
			id: frame.id,
			type: "response",
			command: "set_default_model_selection",
			success: false,
			error,
		});
	});

	test("returns the session operation's stable effective selector tuple", async () => {
		// Given: one strictly matching model and a session operation that records its only invocation.
		const target = { provider: "openai", id: "gpt-5" };
		const calls: Array<{ model: unknown; level: unknown }> = [];

		// When: a valid direct command selects that model.
		const response = await dispatchRpcCommand(
			{
				id: "selection-ok",
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: ThinkingLevel.High,
			},
			ctx({
				getAvailableModels: (() => [target]) as AgentSession["getAvailableModels"],
				setDefaultModelSelection: (async (model: unknown, level: unknown) => {
					calls.push({ model, level });
					return { provider: "openai", modelId: "gpt-5", thinkingLevel: ThinkingLevel.Medium };
				}) as AgentSession["setDefaultModelSelection"],
			}),
		);

		// Then: dispatch delegates once and returns the operation's effective level unchanged.
		expect(calls).toEqual([{ model: target, level: ThinkingLevel.High }]);
		expect(response).toEqual({
			id: "selection-ok",
			type: "response",
			command: "set_default_model_selection",
			success: true,
			data: { provider: "openai", modelId: "gpt-5", thinkingLevel: ThinkingLevel.Medium },
		});
	});

	test("rejects an unknown default model without invoking the session operation", async () => {
		// Given: no available model matches the requested provider and id.
		let invoked = false;

		// When: the command requests an unavailable model.
		const response = await dispatchRpcCommand(
			{
				id: "selection-unknown",
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "missing",
			},
			ctx({
				getAvailableModels: (() => []) as AgentSession["getAvailableModels"],
				setDefaultModelSelection: (async () => {
					invoked = true;
					throw new Error("must not run");
				}) as AgentSession["setDefaultModelSelection"],
			}),
		);

		// Then: lookup fails with correlation and no mutation marker.
		expect(invoked).toBe(false);
		expect(response).toMatchObject({
			id: "selection-unknown",
			command: "set_default_model_selection",
			success: false,
			error: "Model not found: openai/missing",
		});
	});

	test("correlates a default model session-operation failure", async () => {
		// Given: a matching model whose durable session operation fails.
		const target = { provider: "openai", id: "gpt-5" };

		// When: the operation rejects after dispatcher lookup.
		const response = await dispatchRpcCommand(
			{
				id: "selection-operation-error",
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
			},
			ctx({
				getAvailableModels: (() => [target]) as AgentSession["getAvailableModels"],
				setDefaultModelSelection: (async () => {
					throw new Error("durable selection failed");
				}) as AgentSession["setDefaultModelSelection"],
			}),
		);

		// Then: the existing dispatcher error funnel retains id and command.
		expect(response).toMatchObject({
			id: "selection-operation-error",
			command: "set_default_model_selection",
			success: false,
			error: "durable selection failed",
		});
	});

	test("accepts a valid default model selection wire command", () => {
		// Given: a complete selector with an explicit reasoning level.
		const command = {
			id: "selection-1",
			type: "set_default_model_selection",
			provider: "openai",
			modelId: "gpt-5",
			thinkingLevel: ThinkingLevel.High,
		};

		// When: the public wire boundary validates the frame.
		const accepted = isRpcCommand(command);

		// Then: the command is accepted without dispatching it.
		expect(accepted).toBe(true);
	});

	test("accepts a default model selection without an optional reasoning level", () => {
		// Given: a complete model selector with no reasoning override.
		const command = {
			id: "selection-2",
			type: "set_default_model_selection",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		};

		// When: the public wire boundary validates the frame.
		const accepted = isRpcCommand(command);

		// Then: omission preserves the command's optional-level contract.
		expect(accepted).toBe(true);
	});

	test("rejects malformed default model selection wire commands", () => {
		// Given: frames covering missing, blank, non-string, inherited, and unknown selector fields.
		const malformed: readonly unknown[] = [
			{ type: "set_default_model_selection", modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai" },
			{ type: "set_default_model_selection", provider: "   ", modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai", modelId: "\t" },
			{ type: "set_default_model_selection", provider: 42, modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai", modelId: false },
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "",
			},
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: ThinkingLevel.Inherit,
			},
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "extreme",
			},
		];

		// When: each untrusted frame crosses the public wire boundary.
		const results = malformed.map(isRpcCommand);

		// Then: none reaches the typed dispatcher contract.
		expect(results).toEqual(malformed.map(() => false));
	});

	test("rejects an invalid thinking level with a correlated error (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "t1", type: "set_thinking_level", level: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("t1");
		expect(res.command).toBe("set_thinking_level");
	});

	test("rejects an invalid steering mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "s1", type: "set_steering_mode", mode: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("s1");
		expect(res.command).toBe("set_steering_mode");
	});

	test("rejects an invalid interrupt mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "i1", type: "set_interrupt_mode", mode: 123 } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.command).toBe("set_interrupt_mode");
	});

	test("applies a valid thinking level", async () => {
		let applied: unknown;
		const res = await dispatchRpcCommand(
			{ id: "t2", type: "set_thinking_level", level: ThinkingLevel.High },
			ctx({
				setThinkingLevel: ((level: unknown) => {
					applied = level;
				}) as AgentSession["setThinkingLevel"],
			}),
		);
		expect(res.success).toBe(true);
		expect(applied).toBe(ThinkingLevel.High);
	});

	test("a handler exception is correlated to the request id and real command, not 'parse' (issue 01)", async () => {
		// `set_session_name` with no `name` throws inside the handler (command.name.trim()).
		const res = await dispatchRpcCommand({ id: "n1", type: "set_session_name" } as unknown as RpcCommand, ctx());
		expect(res.success).toBe(false);
		expect(res.id).toBe("n1");
		expect(res.command).toBe("set_session_name");
		expect(res.command).not.toBe("parse");
	});

	test("an unknown command preserves the caller's request id (issue 01 default sub-case)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "u1", type: "totally_unknown_command" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("u1");
		expect(res.command).toBe("totally_unknown_command");
	});
});
