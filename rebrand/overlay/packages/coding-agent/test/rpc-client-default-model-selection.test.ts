import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@sayknow-cli/agent-core";
import { RpcClient } from "@sayknow-cli/coding-agent/modes/rpc/rpc-client";

const expectedCommand = {
	type: "set_default_model_selection",
	provider: "openai",
	modelId: "gpt-5.2",
	thinkingLevel: ThinkingLevel.High,
	id: "req_1",
} as const;

async function withFakeServer(responseBody: string, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `skc-rpc-default-model-selection-${Date.now()}-${Math.random()}.js`);
	await Bun.write(
		scriptPath,
		`
let buffer = "";
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			if (JSON.stringify(frame) !== ${JSON.stringify(JSON.stringify(expectedCommand))}) {
				write({ id: frame.id, type: "response", command: frame.type, success: false, error: "unexpected command: " + JSON.stringify(frame) });
			} else {
				${responseBody}
			}
		}
		index = buffer.indexOf("\\n");
	}
});
setInterval(() => {}, 1000);
`,
	);
	const client = new RpcClient({ cliPath: scriptPath });
	try {
		await run(client);
	} finally {
		client.stop();
		await fs.rm(scriptPath, { force: true });
	}
}

describe("RpcClient.setDefaultModelSelection", () => {
	test("sends the exact JSONL command and returns the validated selection", async () => {
		// Given: a fake RPC server that accepts only the exact command envelope.
		await withFakeServer(
			`write({ id: frame.id, type: "response", command: "set_default_model_selection", success: true, data: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "high" } });`,
			async client => {
				await client.start();

				// When: the client requests a concrete default selection.
				const result = await client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High);

				// Then: the correlated, validated tuple is returned.
				expect(result).toEqual({ provider: "openai", modelId: "gpt-5.2", thinkingLevel: ThinkingLevel.High });
			},
		);
	});

	test("uses the idle-deferred command timeout instead of the default request timeout", async () => {
		// Given: a server that accepts the command immediately after startup.
		await withFakeServer(
			`write({ id: frame.id, type: "response", command: "set_default_model_selection", success: true, data: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "high" } });`,
			async client => {
				await client.start();
				const timeout = vi.spyOn(globalThis, "setTimeout");

				try {
					// When: the selection can be deferred until an active session becomes idle.
					await client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High);

					// Then: it receives the longer explicit request deadline without delaying this test.
					expect(timeout).toHaveBeenCalledWith(expect.any(Function), 600_000);
				} finally {
					timeout.mockRestore();
				}
			},
		);
	});

	test("rejects a correlated server error", async () => {
		// Given: a same-id error response for the requested command.
		await withFakeServer(
			`write({ id: frame.id, type: "response", command: "set_default_model_selection", success: false, error: "selection refused" });`,
			async client => {
				await client.start();

				// When/Then: the client surfaces the failure instead of returning a tuple.
				await expect(client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High)).rejects.toThrow(
					"selection refused",
				);
			},
		);
	});

	test("rejects a same-id success response for a different command", async () => {
		// Given: a correlated success response mislabeled as another command.
		await withFakeServer(
			`write({ id: frame.id, type: "response", command: "set_model", success: true, data: { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "high" } });`,
			async client => {
				await client.start();

				// When/Then: command correlation is validated locally.
				await expect(client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High)).rejects.toThrow(
					/set_default_model_selection/,
				);
			},
		);
	});

	for (const [name, data] of [
		["blank provider", { provider: " ", modelId: "gpt-5.2", thinkingLevel: "high" }],
		["blank modelId", { provider: "openai", modelId: "\t", thinkingLevel: "high" }],
		["missing data", undefined],
		["missing thinking level", { provider: "openai", modelId: "gpt-5.2" }],
		["inherit thinking level", { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "inherit" }],
		["unknown thinking level", { provider: "openai", modelId: "gpt-5.2", thinkingLevel: "turbo" }],
	] as const) {
		test(`rejects malformed success data with ${name}`, async () => {
			// Given: a same-id success response with invalid feature data.
			await withFakeServer(
				`write({ id: frame.id, type: "response", command: "set_default_model_selection", success: true, data: ${JSON.stringify(data)} });`,
				async client => {
					await client.start();

					// When/Then: malformed boundary data cannot become a false success.
					await expect(client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High)).rejects.toThrow(
						/Invalid set_default_model_selection response/,
					);
				},
			);
		});
	}

	test("stops a pending request when the fake server stalls", async () => {
		// Given: a server that accepts the exact request but never responds.
		await withFakeServer("", async client => {
			await client.start();
			const pending = client.setDefaultModelSelection("openai", "gpt-5.2", ThinkingLevel.High);

			// When: the client is stopped while the command is pending.
			client.stop();

			// Then: the request rejects promptly instead of hanging until timeout.
			await expect(pending).rejects.toThrow(/stopped|closed/i);
		});
	});
});
