#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const binaryPath = path.resolve(repoRoot, process.argv[2] ?? "packages/coding-agent/dist/skc");
const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-grok-compiled-agent-"));

try {
	const proc = Bun.spawn([binaryPath, "--list-models", "grok-build"], {
		cwd: repoRoot,
		env: {
			...Bun.env,
			SKC_CODING_AGENT_DIR: agentDir,
			SKC_DISABLE_AUTO_UPDATE: "1",
			SKC_GROK_CLI_MODELS: "grok-composer-2.5-fast,grok-build",
			GROK_CLI_OAUTH_TOKEN: "compiled-smoke-token",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const combined = `${stdout}\n${stderr}`;
	if (exitCode !== 0) {
		throw new Error(`compiled skc --list-models failed with ${exitCode}:\n${combined}`);
	}
	if (combined.includes("Bundled Grok Build default is missing")) {
		throw new Error(`compiled skc used missing filesystem defaults:\n${combined}`);
	}
	if (!combined.includes("grok-build") || !combined.includes("grok-composer-2.5-fast")) {
		throw new Error(`compiled skc did not list bundled Grok Build models:\n${combined}`);
	}
	console.log("PASS compiled Grok Build list-models smoke");
} finally {
	await fs.rm(agentDir, { recursive: true, force: true });
}
