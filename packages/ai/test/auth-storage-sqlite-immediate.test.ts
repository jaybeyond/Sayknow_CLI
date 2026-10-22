import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "../src/auth-storage";

// Port of upstream 6a5336feda (#6219): SQLite auth writes reserve the write lock
// up front (BEGIN IMMEDIATE). A deferred read-then-write transaction that reads
// while another process holds the write lock fails with SQLITE_BUSY_SNAPSHOT once
// that process commits, because the read snapshot is stale and busy_timeout does
// not retry a snapshot upgrade. The fork has no OAuth refresh-lease table, so this
// exercises the credential replace/upsert writers instead of the lease claim.
describe("SqliteAuthCredentialStore immediate write reservation", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-ai-auth-immediate-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	async function holdWriteLock(
		holdMs: number,
		writeCacheKey: string,
	): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
		const lockProcess = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/hold-sqlite-write-lock.ts"),
				path.join(tempDir, "agent.db"),
				String(holdMs),
				writeCacheKey,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const reader = lockProcess.stdout.getReader();
		const { value, done } = await reader.read();
		reader.releaseLock();
		if (done || !value || !new TextDecoder().decode(value).includes("LOCKED")) {
			throw new Error("SQLite lock helper did not acquire the write lock");
		}
		return lockProcess;
	}

	test("upsert waits for another process's committed write instead of failing on a stale snapshot", async () => {
		if (!store) throw new Error("test setup failed");
		store.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-ant-first" });

		const lock = await holdWriteLock(200, "peer-upsert");
		expect(() =>
			store?.upsertAuthCredentialForProvider("anthropic", { type: "api_key", key: "sk-ant-second" }),
		).not.toThrow();
		expect(await lock.exited).toBe(0);
		expect(store.getCache("peer-upsert")).toBe("peer");
	});

	test("replace waits for another process's committed write instead of failing on a stale snapshot", async () => {
		if (!store) throw new Error("test setup failed");
		store.replaceAuthCredentialsForProvider("openai", [{ type: "api_key", key: "sk-first" }]);

		const lock = await holdWriteLock(200, "peer-replace");
		expect(() =>
			store?.replaceAuthCredentialsForProvider("openai", [{ type: "api_key", key: "sk-second" }]),
		).not.toThrow();
		expect(await lock.exited).toBe(0);
		expect(store.getCache("peer-replace")).toBe("peer");
		expect(store.listAuthCredentials("openai").map(row => row.credential)).toEqual([
			{ type: "api_key", key: "sk-second" },
		]);
	});
});
