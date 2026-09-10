import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const cliEntrypoint = path.join(packageRoot, "src", "cli.ts");

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, ...args], {
		cwd: packageRoot,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	return {
		exitCode: await child.exited,
		stdout: await new Response(child.stdout).text(),
		stderr: await new Response(child.stderr).text(),
	};
}

describe("removed external ingresses (Phase D structural proof)", () => {
	// Sayknow-CLI keeps `src/modes/rpc` and `src/modes/bridge` as fork-owned library
	// code (published through the `./modes/rpc/*` package export and consumed by
	// `@sayknow-cli/telegram-remote`); only their CLI ingress was removed. The
	// structural proof is therefore that the mode dispatcher wires neither module.
	it("rpc and bridge modes are not wired into the mode dispatcher", () => {
		const dispatcher = fs.readFileSync(path.join(packageRoot, "src", "modes", "index.ts"), "utf8");
		expect(dispatcher).not.toMatch(/from\s+["']\.\/(?:rpc|bridge)(?:\/|["'])/);
		expect(dispatcher).not.toMatch(/\b(?:runRpcMode|runBridgeMode|RpcMode|BridgeMode)\b/);
	});

	it("renders removed --mode values as usage errors", async () => {
		for (const mode of ["rpc", "rpc-ui", "bridge"]) {
			const result = await runCli(["--mode", mode, "-p", "noop"]);
			expect(result.exitCode, `--mode ${mode} must be rejected`).toBe(2);
			expect(result.stderr).toContain(
				`--mode ${mode} was removed; external control now uses the Sayknow-CLI SDK (docs/sdk.md)`,
			);
			expect(result.stdout).toContain("USAGE");
			expect(result.stderr).not.toMatch(/(?:^|\n)(?:Error: )?(?:Error|TypeError|CliParseError):|\bat\s+\S+/);
		}
	}, 30000);

	it("no source file imports the deleted mode modules", () => {
		const violations: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === "node_modules") continue;
					walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				const text = fs.readFileSync(full, "utf8");
				if (/from\s+["'][^"']*modes\/(?:rpc|bridge)\//.test(text)) violations.push(full);
			}
		};
		walk(path.join(packageRoot, "src"));
		expect(violations).toEqual([]);
	});
});
