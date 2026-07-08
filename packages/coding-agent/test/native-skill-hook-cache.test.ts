import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearSkcNativeSkillHookCachesForTesting,
	dispatchSkcNativeSkillHook,
	getSkcNativeSkillHookCacheStatsForTesting,
	resolveSkcNativeSkillConfigForTesting,
	runSkcNativeSkillHookInProcess,
} from "../src/hooks/native-skill-hook";

async function tempRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "skc-native-skill-hook-"));
}

async function runSubprocessHook(payload: Record<string, unknown>): Promise<string> {
	const proc = Bun.spawn(["bun", "src/cli.ts", "codex-native-hook"], {
		cwd: path.join(import.meta.dir, ".."),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			SKC_CONFIG_DIR: ".skc",
			SKC_CODING_AGENT_DIR: path.join(String(payload.cwd), ".skc", "agent"),
		},
	});
	proc.stdin.write(`${JSON.stringify(payload)}\n`);
	proc.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return stdout;
}

describe("SKC native skill hook in-process dispatch and config cache", () => {
	const roots: string[] = [];

	afterEach(async () => {
		clearSkcNativeSkillHookCachesForTesting();
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	});

	it("matches external CLI JSON output for UserPromptSubmit and Stop fixtures", async () => {
		const root = await tempRoot();
		roots.push(root);
		const userPromptPayload = {
			hookEventName: "UserPromptSubmit",
			userPrompt: "?",
			cwd: root,
			sessionId: "session-parity",
			threadId: "thread-parity",
		};
		const stopPayload = {
			hookEventName: "Stop",
			cwd: root,
			sessionId: "session-parity",
			threadId: "thread-parity",
		};

		await expect(runSkcNativeSkillHookInProcess(userPromptPayload)).resolves.toBe(
			await runSubprocessHook(userPromptPayload),
		);
		await expect(runSkcNativeSkillHookInProcess(stopPayload)).resolves.toBe(await runSubprocessHook(stopPayload));
	});

	it("invalidates effective config cache when config mtime changes", async () => {
		const root = await tempRoot();
		roots.push(root);
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "disabledExtensions:\n  - skill:first\n");
		const resolveInput = {
			cwd: root,
			configPaths: [configPath],
			sessionId: "session-cache",
			threadId: "thread-cache",
		};

		const firstWithConfig = await resolveSkcNativeSkillConfigForTesting(resolveInput);
		expect(firstWithConfig.disabledExtensions?.filter(value => value.startsWith("skill:")).length).toBe(1);
		expect(getSkcNativeSkillHookCacheStatsForTesting().effectiveSkillConfigResolutions).toBe(1);

		const cached = await resolveSkcNativeSkillConfigForTesting(resolveInput);
		expect(cached.disabledExtensions?.filter(value => value.startsWith("skill:")).length).toBe(1);
		expect(getSkcNativeSkillHookCacheStatsForTesting().effectiveSkillConfigResolutions).toBe(1);

		await new Promise(resolve => setTimeout(resolve, 5));
		await fs.writeFile(configPath, "disabledExtensions:\n  - skill:first\n  - skill:second\n");
		const invalidated = await resolveSkcNativeSkillConfigForTesting(resolveInput);
		expect(invalidated.disabledExtensions?.filter(value => value.startsWith("skill:")).length).toBe(2);
		expect(getSkcNativeSkillHookCacheStatsForTesting().effectiveSkillConfigResolutions).toBe(2);
	});

	it("does not resolve effective config when no skill activation needs it", async () => {
		const root = await tempRoot();
		roots.push(root);
		const configPath = path.join(root, "config.yml");
		await fs.writeFile(configPath, "::not yaml::");
		await dispatchSkcNativeSkillHook(
			{
				hookEventName: "UserPromptSubmit",
				userPrompt: "ordinary non workflow prompt",
				cwd: root,
				sessionId: "session-no-config",
			},
			{ configPaths: [configPath] },
		);
		expect(getSkcNativeSkillHookCacheStatsForTesting().effectiveSkillConfigResolutions).toBe(0);
	});
});
