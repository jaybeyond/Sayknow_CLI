import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Windows environment variable names are case-insensitive: a project dotenv line
// `userprofile=...` is what `process.env.USERPROFILE` resolves to. Every
// provenance lookup in `dirs.ts`/`env.ts` is spelled upper case, so without
// folding, a lower- or mixed-case declaration is invisible to the trusted-home,
// agent-directory and credential guards while still being live in the process.
//
// These assertions are the only executable proof of the `win32` branch of
// `canonicalEnvKey()`; on POSIX the fold is an identity function and the
// case-distinction requirement is pinned separately in `env.test.ts`.
const windowsOnly = describe.skipIf(process.platform !== "win32");

const tempDirs: string[] = [];

function runEnvIsolationScript(script: string, env: Record<string, string>, cwd: string): void {
	const scriptPath = path.join(cwd, "env-isolation.test.ts");
	fs.writeFileSync(scriptPath, script);
	const result = Bun.spawnSync({
		cmd: [process.execPath, scriptPath],
		cwd,
		env: { PATH: Bun.env.PATH ?? "", SYSTEMROOT: Bun.env.SYSTEMROOT ?? "", ...env },
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) {
		const output = [new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr)]
			.filter(Boolean)
			.join("\n");
		throw new Error(output || `env isolation script exited with ${result.exitCode}`);
	}
}

function scratch(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

const envSourceUrl = (): string => pathToFileURL(path.resolve(import.meta.dir, "../src/env.ts")).href;
const dirsSourceUrl = (): string => pathToFileURL(path.resolve(import.meta.dir, "../src/dirs.ts")).href;

windowsOnly("case-insensitive project dotenv provenance on Windows", () => {
	it("rejects a lowercase userprofile declaration for trusted-home selection", () => {
		const dir = scratch("pi-utils-win-home-");
		const hostileHome = scratch("pi-utils-win-hostile-");
		const realHome = scratch("pi-utils-win-real-");
		const agentDir = scratch("pi-utils-win-agent-");
		fs.writeFileSync(path.join(hostileHome, ".env"), "HOSTILE_HOME_CREDENTIAL=must-not-load\n");
		// Lowercase spelling of the platform-authoritative variable. Windows
		// resolves this into USERPROFILE; the guard must see it too.
		fs.writeFileSync(path.join(dir, ".env"), `userprofile=${hostileHome}\n`);
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl())};
if ($credentialEnv("HOSTILE_HOME_CREDENTIAL") !== undefined) throw new Error("lowercase userprofile bypassed home provenance");
if ($credentialEnv("PRESERVED_OPERATOR_CREDENTIAL") !== "operator-value") throw new Error("inherited credential was dropped");
`,
			{
				USERPROFILE: realHome,
				SKC_CODING_AGENT_DIR: agentDir,
				PRESERVED_OPERATOR_CREDENTIAL: "operator-value",
			},
			dir,
		);
	});

	it("rejects a mixed-case agent-directory override", () => {
		const dir = scratch("pi-utils-win-agentdir-");
		const realHome = scratch("pi-utils-win-real-");
		const hostileAgentDir = scratch("pi-utils-win-hostile-agent-");
		fs.writeFileSync(path.join(dir, ".env"), `Skc_Coding_Agent_Dir=${hostileAgentDir}\n`);
		runEnvIsolationScript(
			`
import { getAgentDir } from ${JSON.stringify(dirsSourceUrl())};
const resolved = getAgentDir();
if (resolved.toLowerCase().startsWith(${JSON.stringify(hostileAgentDir.toLowerCase())})) {
	throw new Error("mixed-case agent-dir override bypassed provenance: " + resolved);
}
`,
			{ USERPROFILE: realHome },
			dir,
		);
	});

	it("rejects a lowercase provider credential declared by the project", () => {
		const dir = scratch("pi-utils-win-cred-");
		const realHome = scratch("pi-utils-win-real-");
		const agentDir = scratch("pi-utils-win-agent-");
		fs.writeFileSync(path.join(dir, ".env"), "anthropic_api_key=project-key\n");
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl())};
if ($credentialEnv("ANTHROPIC_API_KEY") === "project-key") {
	throw new Error("lowercase provider key in the project dotenv was treated as a trusted credential");
}
`,
			{ USERPROFILE: realHome, SKC_CODING_AGENT_DIR: agentDir },
			dir,
		);
	});

	it("still resolves a genuinely inherited uppercase credential", () => {
		const dir = scratch("pi-utils-win-inherit-");
		const realHome = scratch("pi-utils-win-real-");
		const agentDir = scratch("pi-utils-win-agent-");
		runEnvIsolationScript(
			`
import { $credentialEnv } from ${JSON.stringify(envSourceUrl())};
if ($credentialEnv("OPERATOR_ONLY_CREDENTIAL") !== "operator-value") {
	throw new Error("folding dropped an inherited credential that the project never declared");
}
`,
			{ USERPROFILE: realHome, SKC_CODING_AGENT_DIR: agentDir, OPERATOR_ONLY_CREDENTIAL: "operator-value" },
			dir,
		);
	});

	it("exposes canonicalEnvKey as an upper-casing fold on win32", () => {
		expect(process.platform).toBe("win32");
		const dir = scratch("pi-utils-win-fold-");
		runEnvIsolationScript(
			`
import { canonicalEnvKey } from ${JSON.stringify(dirsSourceUrl())};
if (canonicalEnvKey("userprofile") !== "USERPROFILE") throw new Error("win32 fold did not upper-case");
if (canonicalEnvKey("USERPROFILE") !== "USERPROFILE") throw new Error("win32 fold is not idempotent");
`,
			{ USERPROFILE: scratch("pi-utils-win-real-") },
			dir,
		);
	});
});
