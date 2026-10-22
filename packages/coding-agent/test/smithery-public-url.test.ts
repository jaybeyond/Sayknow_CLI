import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAllMCPConfigs } from "../src/runtime-mcp/config";
import { usesPublicNetworkMcpFetch } from "../src/runtime-mcp/plugin-network-boundary";
import { resolveSmitheryServerConfig } from "../src/runtime-mcp/smithery-registry";
import type { MCPHttpServerConfig } from "../src/runtime-mcp/types";

const qualifiedName = "@example/demo";
const publicResolver = async () => ["1.1.1.1"];
/** The exact-config reader refuses symlinked ancestors such as macOS `/var`. */
const tempRoot = realpathSync(tmpdir());

describe("resolveSmitheryServerConfig", () => {
	it("keeps a public deployment URL as an HTTP endpoint", async () => {
		const config = await resolveSmitheryServerConfig(
			qualifiedName,
			{ connection: { type: "http", deploymentUrl: "https://mcp.example.com/rpc" }, useDirectHttp: true },
			{ resolver: publicResolver },
		);
		expect(config).toEqual({ type: "http", url: "https://mcp.example.com/rpc", publicNetwork: true });
		const persisted = JSON.parse(JSON.stringify(config)) as MCPHttpServerConfig;
		expect(persisted.publicNetwork).toBe(true);
		expect(usesPublicNetworkMcpFetch(persisted)).toBe(true);
		expect(usesPublicNetworkMcpFetch({ type: "http", url: "http://127.0.0.1/mcp" })).toBe(false);
	});

	it("does not install a loopback or private deployment URL as a direct HTTP endpoint", async () => {
		for (const deploymentUrl of ["http://127.0.0.1/mcp", "http://169.254.169.254/latest", "http://10.1.2.3/mcp"]) {
			const config = await resolveSmitheryServerConfig(
				qualifiedName,
				{ connection: { type: "http", deploymentUrl }, useDirectHttp: true },
				{ resolver: async () => ["1.1.1.1"] },
			);
			expect(config?.type).toBe("stdio");
			expect(config && "url" in config ? config.url : undefined).toBeUndefined();
		}
	});

	it("keeps the public-network flag when a saved HTTP config is loaded", async () => {
		const dir = await mkdtemp(path.join(tempRoot, "smithery-mcp-"));
		const configPath = path.join(dir, "mcp.json");
		await writeFile(
			configPath,
			JSON.stringify({
				mcpServers: {
					demo: { type: "http", url: "https://mcp.example.com/rpc", publicNetwork: true },
					local: { type: "http", url: "http://127.0.0.1/mcp" },
				},
			}),
		);
		const loaded = await loadAllMCPConfigs(dir, { configPath });
		const demo = loaded.configs.demo as MCPHttpServerConfig;
		const local = loaded.configs.local as MCPHttpServerConfig;
		expect(demo.publicNetwork).toBe(true);
		expect(usesPublicNetworkMcpFetch(demo)).toBe(true);
		expect(local.publicNetwork).toBeUndefined();
		expect(usesPublicNetworkMcpFetch(local)).toBe(false);
	});

	it("keeps the public-network flag through the native .skc/mcp.json loader", async () => {
		const dir = await mkdtemp(path.join(tempRoot, "smithery-native-"));
		await mkdir(path.join(dir, ".skc"), { recursive: true });
		await writeFile(
			path.join(dir, ".skc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: { type: "http", url: "https://mcp.example.com/rpc", publicNetwork: true },
				},
			}),
		);
		const loaded = await loadAllMCPConfigs(dir, { enableProjectConfig: true, filterExa: false });
		const demo = loaded.configs.demo as MCPHttpServerConfig;
		expect(loaded.sources.demo?.provider).toBe("native");
		expect(demo?.publicNetwork).toBe(true);
		expect(usesPublicNetworkMcpFetch(demo)).toBe(true);
	});
});
