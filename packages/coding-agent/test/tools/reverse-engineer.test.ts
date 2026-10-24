import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@sayknow-cli/coding-agent/config/settings";
import type { ToolSession } from "@sayknow-cli/coding-agent/tools";
import {
	REA_COMMANDS,
	REA_VERSION,
	type ReaRunner,
	ReverseEngineerTool,
	type ReverseEngineerToolDetails,
} from "@sayknow-cli/coding-agent/tools/reverse-engineer";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true })));
});

async function createSession(): Promise<ToolSession> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skc-reverse-engineer-"));
	roots.push(root);
	let next = 0;
	return {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getArtifactsDir: () => root,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async () => {
			next += 1;
			return { id: String(next), path: path.join(root, `${next}.reverse_engineer.log`) };
		},
		settings: Settings.isolated({ "reverseEngineer.enabled": true }),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

const npxOnly = (command: string) => (command === "npx" ? "/usr/bin/npx" : null);

function recordingRunner(stdout: string, exitCode = 0): { run: ReaRunner; calls: string[][]; cwds: string[] } {
	const calls: string[][] = [];
	const cwds: string[] = [];
	return {
		calls,
		cwds,
		run: async (argv, options) => {
			calls.push(argv);
			cwds.push(options.cwd);
			return { exitCode, stdout, stderr: "", timedOut: false };
		},
	};
}

describe("reverse_engineer tool", () => {
	it("is discoverable and advertises the build-something-like-this trigger", async () => {
		const tool = new ReverseEngineerTool(await createSession(), { which: npxOnly });
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.summary).toContain("똑같이 만들어줘");
		expect(tool.description).toContain(`rea-agents@${REA_VERSION}`);
		expect(tool.description).toContain("source repository");
	});

	it("runs the pinned REA command without a shell, saves the full result, and elides large strings", async () => {
		const session = await createSession();
		const screenshot = "A".repeat(50_000);
		const stdout = JSON.stringify({ evidence_id: "ev_1", limitations: ["inert syntax only"], screenshot });
		const runner = recordingRunner(stdout);
		const tool = new ReverseEngineerTool(session, { which: npxOnly, run: runner.run });

		const result = await tool.execute("c", {
			op: "run",
			command: "analyze-javascript-application",
			args: ["/apps/notes; rm -rf /"],
		});

		expect(runner.calls).toEqual([
			[
				"npx",
				"-y",
				`rea-agents@${REA_VERSION}`,
				"analyze-javascript-application",
				"/apps/notes; rm -rf /",
				"--format",
				"json",
			],
		]);
		expect(runner.cwds).toEqual([session.cwd]);
		const details = result.details as ReverseEngineerToolDetails;
		expect(details).toMatchObject({ op: "run", command: "analyze-javascript-application", exitCode: 0 });
		expect(await Bun.file(details.savedPath ?? "").text()).toBe(stdout);
		const text = textOf(result);
		expect(text).toContain(`Saved full result: ${details.savedPath}`);
		expect(text).toContain("inert syntax only");
		expect(text).toContain("more chars elided");
		expect(text.length).toBeLessThan(5_000);
	});

	it("keeps an explicit --format and falls back to bunx", async () => {
		const runner = recordingRunner("evidence: yes\n");
		const tool = new ReverseEngineerTool(await createSession(), {
			which: command => (command === "bunx" ? "/bin/bunx" : null),
			run: runner.run,
		});

		await tool.execute("c", { op: "run", command: "doctor", args: ["--format", "yaml"] });

		expect(runner.calls[0]).toEqual(["bunx", `rea-agents@${REA_VERSION}`, "doctor", "--format", "yaml"]);
	});

	it("refuses commands outside the allowlist before running anything", async () => {
		const runner = recordingRunner("{}");
		const tool = new ReverseEngineerTool(await createSession(), { which: npxOnly, run: runner.run });

		for (const command of ["debug-with-gdb", "uninstall", "push-adb-file", "capture-process", "analyze;id"]) {
			await expect(tool.execute("c", { op: "run", command })).rejects.toThrow("not an allowed REA command");
		}
		expect(runner.calls).toHaveLength(0);
		expect(REA_COMMANDS).toContain("capture-browser-scenario");
		expect(REA_COMMANDS).toContain("export-web-scripts");
		expect(REA_COMMANDS).not.toContain("setup");
	});

	it("reports a failing command with its exit code and a timeout as an error", async () => {
		const failing = recordingRunner(JSON.stringify({ error: "Browser scenario capture failed" }), 1);
		const tool = new ReverseEngineerTool(await createSession(), { which: npxOnly, run: failing.run });
		const result = await tool.execute("c", { op: "run", command: "capture-browser-scenario", args: ["{}"] });
		expect(textOf(result)).toContain("failed with exit code 1");
		expect(textOf(result)).toContain("Browser scenario capture failed");

		const slow = new ReverseEngineerTool(await createSession(), {
			which: npxOnly,
			run: async (_argv, options) => {
				expect(options.timeoutMs).toBe(1_800_000);
				return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
			},
		});
		await expect(slow.execute("c", { op: "run", command: "analyze", args: ["/a"], timeout: 99_999 })).rejects.toThrow(
			"did not finish within the timeout",
		);
	});

	it("help returns usage and the input schema", async () => {
		const runner = recordingRunner("Usage: rea analyze <path>");
		const tool = new ReverseEngineerTool(await createSession(), { which: npxOnly, run: runner.run });
		const result = await tool.execute("c", { op: "help", command: "analyze" });

		expect(runner.calls.map(argv => argv.slice(3))).toEqual([
			["analyze", "--help"],
			["analyze", "--schema", "--format", "json"],
		]);
		expect(textOf(result)).toContain("Usage: rea analyze <path>");
	});

	it("browsers lists installed Chromium executables, newest Playwright build first", async () => {
		const home = "/home/u";
		const existing = new Set([
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			`${home}/Library/Caches/ms-playwright/chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
			`${home}/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
			`${home}/Library/Caches/ms-playwright/chromium-999/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
		]);
		const tool = new ReverseEngineerTool(await createSession(), {
			which: npxOnly,
			platform: "darwin",
			homeDir: home,
			fileExists: async file => existing.has(file),
			listDir: async () => [
				"chromium-999",
				"chromium-1200",
				"chromium_headless_shell-1200",
				"chromium-1300",
				"webkit-1",
			],
		});
		const text = textOf(await tool.execute("c", { op: "browsers" }));
		const lines = text.split("\n").filter(line => line.startsWith("- "));

		expect(lines).toEqual([
			"- /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			`- ${home}/Library/Caches/ms-playwright/chromium-1300/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
			`- ${home}/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
			`- ${home}/Library/Caches/ms-playwright/chromium-999/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
		]);
	});
});
