import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { lifecyclePaths } from "@sayknow-cli/coding-agent/skc-runtime/tmux-owner-isolation";
import { interactiveBootstrapText, routeRootArgv } from "../src/cli";
import { parseArgs } from "../src/cli/args";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

function extractRegisteredCommands(source: string): string[] {
	const commandsBlock = source.match(/const commands: CommandEntry\[\] = \[([\s\S]*?)\];/);
	if (!commandsBlock) return [];
	return [...commandsBlock[1].matchAll(/\bname:\s*"([^"]+)"/g)].map(match => match[1]);
}

describe("SKC public CLI command surface", () => {
	it("routes legacy coordinator MCP and team launch invocations to native commands", () => {
		expect(routeRootArgv(["coordinator-mcp"])).toEqual(["mcp-serve", "coordinator"]);
		expect(routeRootArgv(["--team", "--team-size", "2", "team smoke"])).toEqual(["team", "2", "team smoke"]);
		expect(routeRootArgv(["--team", "--team-size=2", "team smoke"])).toEqual(["team", "2", "team smoke"]);
		expect(routeRootArgv(["team discussion", "--team"])).toEqual(["launch", "team discussion", "--team"]);
		expect(routeRootArgv(["--team", "--team-size", "shutdown", "victim"])).toEqual([
			"team",
			"0",
			"invalid legacy --team-size",
		]);
		expect(routeRootArgv(["--team", "--team-size", "2", "--team-size=3", "team smoke"])).toEqual([
			"team",
			"0",
			"invalid legacy --team-size",
		]);
	});

	it("renders an immediate keyboard-ready bootstrap only for interactive launch routes", () => {
		expect(interactiveBootstrapText(["launch"], true, true)).toContain("> ");
		expect(interactiveBootstrapText(["launch", "hello"], true, true)).toContain("warming workspace");
		expect(interactiveBootstrapText(["launch", "--print", "hello"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--export", "session.md"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--list-models"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--mode", "json"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--mode=acp"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--export=session.md"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--list-models=opus"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["config", "get", "theme"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch"], false, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch"], true, false)).toBeUndefined();
	});
	it("suppresses the interactive bootstrap for every explicit output mode form", () => {
		expect(interactiveBootstrapText(["launch", "--mode", "text"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--mode=text"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--mode", "text", "--mode=json"], true, true)).toBeUndefined();
		expect(interactiveBootstrapText(["launch", "--mode=acp", "--mode", "text"], true, true)).toBeUndefined();
	});

	it("suppresses the interactive bootstrap for explicit launch help and version aliases", () => {
		for (const flag of ["--help", "-h", "--version", "-v"]) {
			expect(interactiveBootstrapText(["launch", flag], true, true)).toBeUndefined();
		}
	});
	it("suppresses the interactive bootstrap for parser-accepted equals forms of print, help, and version", () => {
		for (const flag of ["--print=true", "--help=true", "--version=true", "--print=false"]) {
			expect(interactiveBootstrapText(["launch", flag], true, true)).toBeUndefined();
		}
	});

	it("does not prefix spawned noninteractive launch help output with the bootstrap", () => {
		const result = Bun.spawnSync(["bun", cliEntry, "launch", "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
		expect(result.exitCode, output).toBe(0);
		expect(result.stdout.toString()).not.toContain("warming workspace");
	});
	it("routes the internal managed-owner supervisor through its child admission barrier", async () => {
		if (process.platform !== "linux") return;
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-cli-supervisor-"));
		const lifecycle = lifecyclePaths(stateDir, "session-cli-route", "generation-cli-route");
		const managedOwnerEnv = {
			...process.env,
			SKC_TMUX_OWNER_STATE_DIR: stateDir,
			SKC_COORDINATOR_SESSION_ID: "session-cli-route",
			SKC_TMUX_OWNER_GENERATION: "generation-cli-route",
			SKC_MANAGED_OWNER_RUN_ID: "run-cli-route",
			SKC_MANAGED_OWNER_INCARNATION: "incarnation-cli-route",
		};
		try {
			const admitted = Bun.spawnSync(["bun", cliEntry, "--internal-managed-owner-supervisor"], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...managedOwnerEnv,
					SKC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([process.execPath, cliEntry, "--version"]),
				},
			});
			const admittedOutput = `${admitted.stdout.toString()}\n${admitted.stderr.toString()}`;
			expect(admitted.exitCode, admittedOutput).toBe(0);
			expect(admitted.stdout.toString()).toMatch(/^skc\/\d+\.\d+\.\d+\n$/);
			const bindingFiles = (await fs.readdir(lifecycle.root)).filter(
				file => file.startsWith("child-") && file.endsWith(".binding.json"),
			);
			expect(bindingFiles).toHaveLength(1);
			await fs.rm(path.join(lifecycle.root, bindingFiles[0]!));

			const unboundChild = `import { readdir, writeFile } from "node:fs/promises";
const binding = (await readdir(process.env.SKC_MANAGED_OWNER_BINDING_DIR!)).find(file => file.startsWith("child-"));
if (!binding) throw new Error("binding_missing");
await writeFile(\`\${process.env.SKC_MANAGED_OWNER_BINDING_DIR}/\${binding}\`, "{}\\n");
const child = Bun.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(cliEntry)}, "--version"], { stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;`;
			const blocked = Bun.spawnSync(["bun", cliEntry, "--internal-managed-owner-supervisor"], {
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...managedOwnerEnv,
					SKC_TMUX_OWNER_GENERATION: "generation-cli-blocked",
					SKC_MANAGED_OWNER_COMMAND_JSON: JSON.stringify([process.execPath, "-e", unboundChild]),
					SKC_MANAGED_OWNER_BINDING_DIR: lifecyclePaths(stateDir, "session-cli-route", "generation-cli-blocked")
						.root,
				},
			});
			const blockedOutput = `${blocked.stdout.toString()}\n${blocked.stderr.toString()}`;
			expect(blocked.exitCode, blockedOutput).toBe(75);
			expect(blockedOutput).not.toContain("skc/");
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("registers launch plus retained workflow/runtime utility endpoints", async () => {
		const source = await Bun.file(cliEntry).text();
		expect(extractRegisteredCommands(source)).toEqual([
			"codex-native-hook",
			"state",
			"setup",
			"skills",
			"session",
			"harness",
			"coordinator",
			"team",
			"ultragoal",
			"gc",
			"ralplan",
			"config",
			"notify",
			"daemon",
			"web-search",
			"local-provider",
			"mcp-serve",
			"mcp",
			"contribute-pr",
			"deep-interview",
			"migrate",
			"rlm",
			"update",
			"read",
			"plugin",
			"launch",
			"telegram",
		]);
	});

	it("exposes the update command help without launching the TUI", () => {
		const result = Bun.spawnSync(["bun", cliEntry, "update", "--help"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const stdout = result.stdout.toString();
		const stderr = result.stderr.toString();
		const combined = `${stdout}\n${stderr}`;

		expect(result.exitCode, combined).toBe(0);
		expect(stdout).toContain("Check for and install updates");
		expect(combined).not.toContain("What's New");
		expect(combined).not.toContain("chatContainer");
	}, 30_000);

	it("documents the native CLI surface in command help", async () => {
		for (const command of ["ralplan", "deep-interview", "state"]) {
			const result = Bun.spawnSync(["bun", cliEntry, command, "--help"], {
				cwd: repoRoot,
				stderr: "pipe",
				stdout: "pipe",
			});
			const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

			expect(result.exitCode, output).toBe(0);
			expect(output).not.toContain("SKC_RUNTIME_BINARY");
			expect(output).not.toContain("private runtime");
		}
	}, 30_000);

	it("documents team dry-run state behavior in command help", async () => {
		const result = Bun.spawnSync(["bun", cliEntry, "team", "--help"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

		expect(result.exitCode, output).toBe(0);
		expect(output).toContain("--dry-run");
		expect(output).toContain(".skc/_session-{sessionid}/state/team");
		expect(output).toContain("do not commit");
		expect(output).toContain("existing tmux/SKC --tmux session");
		expect(output).toContain("skc --tmux");
	}, 30_000);

	it("routes legacy team help before root help fast paths", () => {
		const result = Bun.spawnSync(["bun", cliEntry, "--team", "--team-size", "2", "--help"], {
			cwd: repoRoot,
			stderr: "pipe",
			stdout: "pipe",
		});
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;

		expect(result.exitCode, output).toBe(0);
		expect(output).toContain("--dry-run");
		expect(output).toContain(".skc/_session-{sessionid}/state/team");
	}, 30_000);

	it("preserves root fast-path and legacy team-help precedence", () => {
		const cases = [
			{ args: ["--tmux", "--version"], output: /^skc\/\d+\.\d+\.\d+\n$/ },
			{ args: ["--tmux", "-v"], output: /^skc\/\d+\.\d+\.\d+\n$/ },
			{ args: ["--resume", "--version"], output: /^skc\/\d+\.\d+\.\d+\n$/ },
			{ args: ["--resume", "-v"], output: /^skc\/\d+\.\d+\.\d+\n$/ },
			{ args: ["--help"], output: "USAGE" },
			{ args: ["--tmux", "--help"], output: "USAGE" },
			{ args: ["--resume", "--help"], output: "USAGE" },
			{ args: ["--team", "--team-size", "2", "--help"], output: "--dry-run" },
			{ args: ["--team", "--team-size=2", "--help"], output: "--dry-run" },
			{ args: ["--team", "--team-size", "2", "-h"], output: "--dry-run" },
		];

		for (const { args, output } of cases) {
			const result = Bun.spawnSync(["bun", cliEntry, ...args], {
				cwd: repoRoot,
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();

			expect(result.exitCode, stderr).toBe(0);
			if (typeof output === "string") expect(stdout).toContain(output);
			else expect(stdout).toMatch(output);
		}
	}, 30_000);

	it("does not capture absolute-path prompts as startup slash commands", () => {
		const parsed = parseArgs(["/tmp/request.md", "--model", "opus", "summarize"]);

		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["/tmp/request.md", "summarize"]);
	});

	it("keeps startup slash payload intact after normal CLI flags", () => {
		const parsed = parseArgs([
			"--no-lsp",
			"/provider",
			"add",
			"--compat",
			"anthropic",
			"--provider",
			"minimax",
			"--base-url",
			"https://api.minimax.io/anthropic",
			"--api-key-env",
			"MINIMAX_APIKEY",
			"--model",
			"MiniMax-M2.7-highspeed",
		]);

		expect(parsed.noLsp).toBe(true);
		expect(parsed.provider).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.messages).toEqual([
			"/provider add --compat anthropic --provider minimax --base-url https://api.minimax.io/anthropic --api-key-env MINIMAX_APIKEY --model MiniMax-M2.7-highspeed",
		]);
	});

	it("keeps CLI slash-command invocations as one initial message", () => {
		const parsed = parseArgs([
			"/provider",
			"add",
			"--compat",
			"anthropic",
			"--provider",
			"minimax",
			"--base-url",
			"https://api.minimax.io/anthropic",
			"--api-key-env",
			"MINIMAX_APIKEY",
			"--model",
			"MiniMax-M2.7-highspeed",
		]);

		expect(parsed.messages).toEqual([
			"/provider add --compat anthropic --provider minimax --base-url https://api.minimax.io/anthropic --api-key-env MINIMAX_APIKEY --model MiniMax-M2.7-highspeed",
		]);
	});

	it("routes bare setup as the default workflow-skill setup command", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "skc-setup-command-home-"));
		try {
			const result = Bun.spawnSync(["bun", cliEntry, "setup", "--json"], {
				cwd: repoRoot,
				env: { ...process.env, HOME: home, SKC_CODING_AGENT_DIR: path.join(home, ".skc", "agent") },
				stderr: "pipe",
				stdout: "pipe",
			});
			const stdout = result.stdout.toString();
			const stderr = result.stderr.toString();

			expect(result.exitCode, stderr).toBe(0);
			const payload = JSON.parse(stdout) as { written?: number; targetRoot?: string };
			expect(payload.written).toBe(8);
			expect(payload.targetRoot).toContain(path.join(home, ".skc", "agent"));
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}, 15_000);
});
