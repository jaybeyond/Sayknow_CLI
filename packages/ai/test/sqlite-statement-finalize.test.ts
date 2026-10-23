import { Database, type Statement } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "../src/auth-storage";
import { closeModelCache, readModelCache } from "../src/model-cache";

// Ported from upstream gajae ccafa69264 (#6696). On Windows a statement that
// outlives disposal keeps the owned database file open. The fork runs Bun 1.3.14,
// where Database.close(true) throws "database is locked" for a live statement
// instead of finalizing it (upstream's close(true) assumes Bun 1.4), so the
// store keeps close() and must finalize every statement it created itself.

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function makeTemp(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Record every statement the database hands out and whether it was finalized. */
function trackStatements(database: Database): { live: () => string[] } {
	const tracked: Array<{ sql: string; finalized: boolean }> = [];
	const wrap = <T extends Statement>(sql: string, statement: T): T => {
		const entry = { sql, finalized: false };
		tracked.push(entry);
		const finalize = statement.finalize.bind(statement);
		statement.finalize = () => {
			entry.finalized = true;
			finalize();
		};
		return statement;
	};
	const prepare = database.prepare.bind(database);
	const query = database.query.bind(database);
	database.prepare = ((sql: string, ...rest: unknown[]) =>
		wrap(sql, (prepare as (...args: unknown[]) => Statement)(sql, ...rest))) as Database["prepare"];
	database.query = ((sql: string) => wrap(sql, query(sql))) as Database["query"];
	return { live: () => tracked.filter(entry => !entry.finalized).map(entry => entry.sql) };
}

describe("SQLite statement finalization at disposal", () => {
	it("finalizes every auth store statement, including migration and lookup ones, before close", async () => {
		const root = await makeTemp("skc-auth-finalize-");
		const database = new Database(path.join(root, "auth.db"));
		const statements = trackStatements(database);
		const store = new SqliteAuthCredentialStore(database);
		store.saveApiKey("openai", "first-key");
		const [row] = store.listAuthCredentials("openai");
		expect(row).toBeDefined();
		store.updateAuthCredential(row!.id, { type: "api_key", key: "second-key" });
		store.close();
		expect(statements.live()).toEqual([]);
		store.close();
	});

	it("finalizes the model-cache schema and lookup statements", async () => {
		const root = await makeTemp("skc-model-cache-finalize-");
		const dbPath = path.join(root, "models.db");
		const legacy = new Database(dbPath, { create: true });
		legacy.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacy.close();
		const originalQuery = Database.prototype.query;
		const live: string[] = [];
		Database.prototype.query = function (this: Database, sql: string) {
			const statement = originalQuery.call(this, sql) as Statement;
			live.push(sql);
			const finalize = statement.finalize.bind(statement);
			statement.finalize = () => {
				live.splice(live.indexOf(sql), 1);
				finalize();
			};
			return statement;
		} as Database["query"];
		try {
			expect(readModelCache("ollama-cloud", 60_000, Date.now, dbPath)).toBeNull();
		} finally {
			Database.prototype.query = originalQuery;
		}
		expect(live).toEqual([]);
		expect(closeModelCache(dbPath)).toBe(true);
		expect(closeModelCache(dbPath)).toBe(false);
		await fs.rm(root, { recursive: true });
	});
});
