import { describe, expect, it } from "bun:test";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import { createAcpExtensionUiContext } from "../src/modes/acp/acp-agent";

/**
 * Contract coverage for the ACP form-elicitation bridge. The bridge owns no
 * session runtime: it forwards select/confirm/input to the client's
 * `unstable_createElicitation` reverse call and fails closed (stub fallback)
 * whenever the client lacks the form capability or the dialog is aborted.
 */

interface CapturedElicitation {
	sessionId?: unknown;
	message?: unknown;
	requestedSchema?: {
		type?: unknown;
		properties?: { value?: Record<string, unknown> };
		required?: unknown;
	};
}

const FORM_CAPABILITIES = { elicitation: { form: {} } } as unknown as ClientCapabilities;

function connectionStub(respond: (input: CapturedElicitation) => unknown): {
	connection: AgentSideConnection;
	calls: CapturedElicitation[];
} {
	const calls: CapturedElicitation[] = [];
	const connection = {
		unstable_createElicitation: async (input: CapturedElicitation) => {
			calls.push(input);
			const result = respond(input);
			if (result instanceof Error) throw result;
			return { content: { value: result } };
		},
	} as unknown as AgentSideConnection;
	return { connection, calls };
}

describe("ACP elicitation bridge", () => {
	it("falls back without any reverse call when the client lacks the form capability", async () => {
		const { connection, calls } = connectionStub(() => "unused");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", undefined);

		expect(await ctx.select("Pick", ["a", "b"])).toBeUndefined();
		expect(await ctx.confirm("Sure?")).toBe(false);
		expect(await ctx.input("Name?")).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("falls back without any reverse call when the dialog signal is already aborted", async () => {
		const { connection, calls } = connectionStub(() => "a");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);
		const controller = new AbortController();
		controller.abort();

		expect(await ctx.select("Pick", ["a"], { signal: controller.signal })).toBeUndefined();
		expect(await ctx.confirm("Sure?", undefined, { signal: controller.signal })).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("translates select to a single-property string-enum elicitation", async () => {
		const { connection, calls } = connectionStub(() => "second");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.select("Pick one", ["first", "second", "third"])).toBe("second");
		expect(calls).toHaveLength(1);
		const request = calls[0]!;
		expect(request.sessionId).toBe("session-a");
		expect(request.message).toBe("Pick one");
		expect(request.requestedSchema?.type).toBe("object");
		expect(request.requestedSchema?.required).toEqual(["value"]);
		expect(request.requestedSchema?.properties?.value).toEqual({
			type: "string",
			enum: ["first", "second", "third"],
		});
	});

	it("rejects a select answer outside the offered options", async () => {
		const { connection } = connectionStub(() => "not-an-option");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.select("Pick", ["a", "b"])).toBeUndefined();
	});

	it("translates confirm to a boolean elicitation and joins the detail into the message", async () => {
		const { connection, calls } = connectionStub(() => true);
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.confirm("Proceed?", "Detail line")).toBe(true);
		expect(calls[0]!.message).toBe("Proceed?\n\nDetail line");
		expect(calls[0]!.requestedSchema?.properties?.value).toEqual({ type: "boolean" });
	});

	it("returns false for any non-true confirm answer", async () => {
		const { connection } = connectionStub(() => "yes");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.confirm("Proceed?")).toBe(false);
	});

	it("translates input to a string elicitation and joins the placeholder into the message", async () => {
		const { connection, calls } = connectionStub(() => "claude");
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.input("Model?", "e.g. claude")).toBe("claude");
		expect(calls[0]!.message).toBe("Model?\n\ne.g. claude");
		expect(calls[0]!.requestedSchema?.properties?.value).toEqual({ type: "string" });
		expect(await ctx.input("Model?")).toBe("claude");
		expect(calls[1]!.message).toBe("Model?");
	});

	it("returns undefined when the input answer is not a string", async () => {
		const { connection } = connectionStub(() => 42);
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.input("Number?")).toBeUndefined();
	});

	it("resolves to the stub fallback when the reverse call rejects", async () => {
		const { connection } = connectionStub(() => new Error("client exploded"));
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		expect(await ctx.select("Pick", ["a"])).toBeUndefined();
		expect(await ctx.confirm("Sure?")).toBe(false);
		expect(await ctx.input("Name?")).toBeUndefined();
	});

	it("resolves to the stub fallback when the dialog times out before the client answers", async () => {
		let timedOut = false;
		const never = new Promise<never>(() => undefined);
		const connection = {
			unstable_createElicitation: () => never,
		} as unknown as AgentSideConnection;
		const ctx = createAcpExtensionUiContext(connection, () => "session-a", FORM_CAPABILITIES);

		const result = await ctx.select("Pick", ["a"], {
			timeout: 5,
			onTimeout: () => {
				timedOut = true;
			},
		});
		expect(result).toBeUndefined();
		expect(timedOut).toBe(true);
	});

	it("reads the sessionId getter on every elicitation so mid-flight session changes are reflected", async () => {
		const { connection, calls } = connectionStub(() => "a");
		let sessionId = "session-1";
		const ctx = createAcpExtensionUiContext(connection, () => sessionId, FORM_CAPABILITIES);

		await ctx.select("Pick", ["a"]);
		sessionId = "session-2";
		await ctx.input("Name?");
		expect(calls.map(call => call.sessionId)).toEqual(["session-1", "session-2"]);
	});
});
