import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@sayknow-cli/coding-agent/modes/rpc/rpc-client";

/** `--mode rpc` is retired (docs/sdk.md); the CLI exits with a usage error before startup. */
const REMOVAL_MESSAGE = "--mode rpc was removed; external control now uses the Sayknow-CLI SDK (docs/sdk.md)";

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: { PI_NO_TITLE: "1" },
		});

		// The usage text lands on stdout, so the rejection must surface the child's exit
		// code and stderr (the removal notice) rather than a JSONL parse failure.
		const error = await client.start().then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/exited with code 2/);
		expect((error as Error).message).toContain(REMOVAL_MESSAGE);
		expect((error as Error).message).not.toContain("Failed to parse JSONL");
	}, 30_000);
});
