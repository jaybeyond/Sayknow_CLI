import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
} from "@sayknow-cli/coding-agent/session/session-manager";
import { SKC_SESSION_FILE_ENV, SKC_SESSION_ID_ENV } from "@sayknow-cli/coding-agent/skc-runtime/goal-mode-request";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-session-file-dotenv-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeTranscript(sessionFile: string, cwd: string): Promise<void> {
	const timestamp = new Date().toISOString();
	await Bun.write(
		sessionFile,
		[
			JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp, cwd }),
			JSON.stringify({
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: "start ultragoal" }] },
			}),
			"",
		].join("\n"),
	);
}

function runCreateGoals(cwd: string, sessionFile: string) {
	const cliPath = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");
	return Bun.spawnSync(["bun", cliPath, "ultragoal", "create-goals", "--brief", "Ship native goal"], {
		cwd,
		env: {
			...process.env,
			[SKC_SESSION_FILE_ENV]: sessionFile,
			[SKC_SESSION_ID_ENV]: "session-owner",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function goalMode(sessionFile: string): Promise<string | undefined> {
	const entries = (await loadEntriesFromFile(sessionFile)).filter(
		(entry): entry is SessionEntry => entry.type !== "session",
	);
	return buildSessionContext(entries).mode;
}

describe("ultragoal session file dotenv provenance", () => {
	it("does not follow a project dotenv SKC_SESSION_FILE into another transcript", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const sessionFile = path.join(outside, "victim.jsonl");
		await writeTranscript(sessionFile, outside);
		await Bun.write(path.join(root, ".env"), `${SKC_SESSION_FILE_ENV}=${sessionFile}\n`);
		const before = await Bun.file(sessionFile).text();

		const result = runCreateGoals(root, sessionFile);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await Bun.file(sessionFile).text()).toBe(before);
		expect(await goalMode(sessionFile)).not.toBe("goal");
	}, 30_000);

	it("keeps an operator SKC_SESSION_FILE the project dotenv does not declare", async () => {
		const root = await tempDir();
		const sessionFile = path.join(root, "operator-session.jsonl");
		await writeTranscript(sessionFile, root);
		await Bun.write(path.join(root, ".env"), "UNRELATED_PROJECT_FLAG=1\n");

		const result = runCreateGoals(root, sessionFile);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await goalMode(sessionFile)).toBe("goal");
	}, 30_000);

	it("keeps an operator session path when the project dotenv declares a different path", async () => {
		const root = await tempDir();
		const outside = await tempDir();
		const planted = path.join(outside, "planted.jsonl");
		const operator = path.join(root, "operator-session.jsonl");
		await writeTranscript(planted, outside);
		await writeTranscript(operator, root);
		await Bun.write(path.join(root, ".env"), `${SKC_SESSION_FILE_ENV}=${planted}\n`);
		const plantedBefore = await Bun.file(planted).text();

		const result = runCreateGoals(root, operator);

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await Bun.file(planted).text()).toBe(plantedBefore);
		expect(await goalMode(operator)).toBe("goal");
	}, 30_000);
});
