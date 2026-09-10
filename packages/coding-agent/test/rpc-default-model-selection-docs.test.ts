import { describe, expect, test } from "bun:test";
import * as path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

async function readRepositoryFile(relativePath: string): Promise<string> {
	return Bun.file(path.join(repositoryRoot, relativePath)).text();
}

describe("durable default model selection documentation", () => {
	test("lists every concrete thinking level in the command inventory", async () => {
		// Given the canonical RPC reference
		const rpcDoc = await readRepositoryFile("docs/rpc.md");

		// When the durable default command inventory is inspected
		const commandInventory = rpcDoc.match(/^- `\{ id\?, type: "set_default_model_selection"[^\n]+$/m)?.[0];
		const documentedLevels = commandInventory
			?.match(/thinkingLevel\?: ([^}]+) \}/)?.[1]
			?.match(/"[^"]+"/g)
			?.map(level => level.slice(1, -1));

		// Then it enumerates the complete concrete-level contract
		expect(documentedLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	test("documents the exact request and success response fields", async () => {
		// Given the canonical RPC reference
		const rpcDoc = await readRepositoryFile("docs/rpc.md");

		// When the durable default command contract is inspected
		const contract = rpcDoc.match(/### `set_default_model_selection` contract[\s\S]*?(?=\n### |\n## |$)/)?.[0];

		// Then the wire shapes are explicit and correlated
		expect(contract).toContain(
			'{ "id": "model-default-1", "type": "set_default_model_selection", "provider": "openai", "modelId": "gpt-5.6", "thinkingLevel": "high" }',
		);
		expect(contract).toContain(
			'{ "id": "model-default-1", "type": "response", "command": "set_default_model_selection", "success": true, "data": { "provider": "openai", "modelId": "gpt-5.6", "thinkingLevel": "high" } }',
		);
	});

	test("documents concrete effective-level normalization", async () => {
		// Given the canonical RPC reference
		const rpcDoc = await readRepositoryFile("docs/rpc.md");

		// When the thinking-level rules are inspected
		const contract = rpcDoc.match(/### `set_default_model_selection` contract[\s\S]*?(?=\n### |\n## |$)/)?.[0];

		// Then inherit, clamping, and non-reasoning normalization are unambiguous
		expect(contract).toContain("`thinkingLevel` may be omitted or set to a concrete level");
		expect(contract).toContain('`"inherit"` is rejected');
		expect(contract).toContain("clamped to the selected model's supported range");
		expect(contract).toContain("A non-reasoning model always resolves to `off`");
	});

	test("documents durability, ordering, streaming, and precedence limits", async () => {
		// Given the canonical RPC reference
		const rpcDoc = await readRepositoryFile("docs/rpc.md");

		// When the command lifecycle is inspected
		const contract = rpcDoc.match(/### `set_default_model_selection` contract[\s\S]*?(?=\n### |\n## |$)/)?.[0];

		// Then acknowledgement and the limited durable promise are exact
		expect(contract).toContain("acknowledges success only after the machine-global selector is durably written");
		expect(contract).toContain("ordered mutation");
		expect(contract).toContain("waits for an active stream to become idle");
		expect(contract).toContain("applies to the next message");
		expect(contract).toContain("Project-level model-role policy overrides the machine-global selector");
		expect(contract).toContain("a resumed session's recorded default model overrides it");
	});

	test("documents Bridge authorization reachability without claiming enabled endpoints", async () => {
		// Given the RPC and Bridge references
		const [rpcDoc, bridgeDoc] = await Promise.all([
			readRepositoryFile("docs/rpc.md"),
			readRepositoryFile("docs/bridge.md"),
		]);

		// When their shared command catalog is inspected
		const contract = rpcDoc.match(/### `set_default_model_selection` contract[\s\S]*?(?=\n### |\n## |$)/)?.[0];

		// Then the consequence is limited to the authorized shared surface
		expect(contract).toContain("shared agent-wire command surface");
		expect(contract).toContain("Bridge command endpoint is enabled");
		expect(contract).toContain("requires the `model` scope");
		expect(bridgeDoc).toContain("| `set_default_model_selection` | `model` |");
	});

	test("records the durable default's retirement and its SDK migration path", async () => {
		// Given the SDK reference and the RPC-to-SDK parity audit (the fork's changelog
		// tracks fork releases only; the retired RPC contract's status lives in these docs)
		const [sdkDoc, parityAudit] = await Promise.all([
			readRepositoryFile("docs/sdk.md"),
			readRepositoryFile("docs/sdk-rpc-parity-audit.md"),
		]);

		// When the removed-mode migration guidance is inspected
		const migration = sdkDoc.match(/## Migration from the removed RPC mode[\s\S]*?(?=\n## |$)/)?.[0];

		// Then the retired transport, its canonical successor, and the audit are named
		expect(migration).toContain("The retired `--mode rpc`, `rpc-ui`, and `bridge` modes are removed.");
		expect(migration).toContain("canonical external control/query bus");
		expect(migration).toContain("sdk-rpc-parity-audit.md");

		// And the durable selector maps to `model.set` without overstating the retired envelope
		const auditRow = parityAudit.match(/^\| Model \| `set_default_model_selection` \|[^\n]+$/m)?.[0];
		expect(auditRow).toContain("`model.set` with `thinkingLevel`");
		expect(auditRow).toContain("not the retired durable-selector response envelope");
	});
});
