/**
 * Shared fixtures for the verification-receipts tests: temp agent dir with an installed-layout directory,
 * throwaway git repositories and a minimal CustomToolAPI. Never touches the real ~/.skc.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod/v4";

export const BUNDLE = path.resolve(import.meta.dir, "../../bundles/verification-receipts");
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const temps: string[] = [];
export async function cleanupTemps(): Promise<void> {
	for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
}
export async function mkTemp(prefix = "skc-vr-test-"): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	temps.push(dir);
	return dir;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(
		["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			env: { PATH: process.env.PATH ?? "", HOME: cwd, ...GIT_ENV },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, out, err] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
	return out;
}

export async function write(repo: string, rel: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
	await fs.writeFile(path.join(repo, rel), content);
}

export const PASS_TEST = `import { expect, test } from "bun:test";\ntest("passes", () => { expect(1 + 1).toBe(2); });\n`;
export const FAIL_TEST = `import { expect, test } from "bun:test";\ntest("fails", () => { expect(1).toBe(2); });\n`;

/** A committed repository with one passing bun test and an `a.ts` source. */
export async function mkRepo(): Promise<string> {
	const repo = await mkTemp("skc-vr-repo-");
	await git(repo, "init", "-q", "-b", "main");
	await write(repo, "a.ts", "export const a = 1;\n");
	await write(repo, "a.test.ts", PASS_TEST);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	return repo;
}

export interface Env {
	root: string;
	agentDir: string;
	/** `<agentDir>/skc-plugins/verification-receipts` */
	pluginRoot: string;
	toolsDir: string;
	hooksDir: string;
	storeRoot: string;
	env: NodeJS.ProcessEnv;
}

/** Temp agent dir with the bundle copied into the installed layout (declared files only). */
export async function mkEnv(): Promise<Env> {
	const root = await mkTemp("skc-vr-env-");
	const agentDir = path.join(root, "agent");
	const pluginRoot = path.join(agentDir, "skc-plugins", "verification-receipts");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	for (const sub of ["tools", "hooks"]) {
		await fs.mkdir(path.join(pluginRoot, sub), { recursive: true });
		for (const name of await fs.readdir(path.join(BUNDLE, sub))) {
			await fs.copyFile(path.join(BUNDLE, sub, name), path.join(pluginRoot, sub, name));
		}
	}
	return {
		root,
		agentDir,
		pluginRoot,
		toolsDir: path.join(pluginRoot, "tools"),
		hooksDir: path.join(pluginRoot, "hooks"),
		storeRoot: path.join(agentDir, "skc-plugin-data", "verification-receipts"),
		env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, USER: "t", LOGNAME: "t", ...GIT_ENV },
	};
}

export interface WarnLog {
	messages: string[];
}
export function mkPi(cwd: string, env: Env, log: WarnLog = { messages: [] }) {
	return {
		cwd,
		zod: z,
		logger: { warn: (m: string) => log.messages.push(m), error: () => {}, debug: () => {} },
		pi: { getAgentDir: () => env.agentDir },
	} as never;
}

export interface Installed {
	run: typeof import("../../bundles/verification-receipts/tools/verification-run");
	status: typeof import("../../bundles/verification-receipts/tools/verification-status");
	loop: typeof import("../../bundles/verification-receipts/tools/verification-loop");
	gate: typeof import("../../bundles/verification-receipts/hooks/verification-gate");
	baseline: typeof import("../../bundles/verification-receipts/hooks/verification-baseline");
}
/** Import the copies installed in the temp agent dir, so `import.meta.dir` is the installed layout. */
export async function loadInstalled(env: Env): Promise<Installed> {
	return {
		run: await import(path.join(env.toolsDir, "verification-run.ts")),
		status: await import(path.join(env.toolsDir, "verification-status.ts")),
		loop: await import(path.join(env.toolsDir, "verification-loop.ts")),
		gate: await import(path.join(env.hooksDir, "verification-gate.ts")),
		baseline: await import(path.join(env.hooksDir, "verification-baseline.ts")),
	};
}
export const sess = (id = "sess") => ({ sessionManager: { getSessionId: () => id } });
