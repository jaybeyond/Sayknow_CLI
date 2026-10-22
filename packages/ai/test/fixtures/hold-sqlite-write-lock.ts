import { Database } from "bun:sqlite";

const dbPath = Bun.argv[2];
if (!dbPath) throw new Error("database path is required");
const holdMs = Number(Bun.argv[3] ?? 50);
// Optional: commit a real change so a deferred reader's snapshot goes stale.
const writeCacheKey = Bun.argv[4];

const db = new Database(dbPath);
db.run("PRAGMA busy_timeout=5000");
db.run("BEGIN IMMEDIATE");
process.stdout.write("LOCKED\n");
await Bun.sleep(holdMs);
if (writeCacheKey) {
	db.prepare("INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)").run(
		writeCacheKey,
		"peer",
		Math.floor(Date.now() / 1000) + 3600,
	);
}
db.run("COMMIT");
db.close();
