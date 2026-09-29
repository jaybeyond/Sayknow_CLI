/**
 * Tests for the new usage-cache contracts introduced after the broker
 * migration surfaced Anthropic per-IP rate limits:
 *
 *   1. Per-credential cache stores the last successful report; failures
 *      DON'T overwrite a stale-but-good entry with null.
 *   2. With a stale-but-good entry, a failure serves the previous value
 *      (cached for a short cool-down) instead of dropping the credential
 *      from the report.
 *   3. Without a previous value, a failure returns null and DOES NOT cache —
 *      the next poll retries on the next request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "../src/auth-storage";
import type { UsageReport } from "../src/usage";
import * as claudeUsage from "../src/usage/claude";

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(r => r.provider === "anthropic");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}

	throw new Error("Timed out waiting for condition");
}

/**
 * Force every cache entry to look stale to AuthStorage WITHOUT dropping the
 * value. The cache layer is two-tier: the store-level `expiresAtSec` controls
 * whether `getCache` returns anything at all, and the JSON payload's own
 * `expiresAt` is what AuthStorage compares against `Date.now()` to decide if
 * the entry is fresh. Mutating only the inner expiresAt simulates time
 * passing while keeping the last-good value reachable for the failure path.
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			// Just past freshness, still inside the 24h last-good retention window.
			parsed.expiresAt = Date.now() - 1;
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

/**
 * Simulate `ageMs` passing for every per-credential report: shift the report's
 * `fetchedAt` back and expire its freshness, and drop aggregate snapshots so
 * the next poll re-evaluates each credential.
 */
function ageStoredReports(store: ObservableStore, ageMs: number): void {
	for (const [key, entry] of store.cache) {
		if (key.includes("reports:")) {
			store.cache.delete(key);
			continue;
		}
		if (!key.includes("usage_cache:report:")) continue;
		const parsed = JSON.parse(entry.value);
		parsed.expiresAt = Date.now() - 1;
		if (parsed.value && typeof parsed.value.fetchedAt === "number") parsed.value.fetchedAt -= ageMs;
		store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
	}
}

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
	leaseCalls: number[];
}

/**
 * Minimal in-memory `AuthCredentialStore` exposing the cache so we can
 * assert what AuthStorage writes to it during usage fetches.
 */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	const leaseCalls: number[] = [];
	const leaseOwners = new Map<string, string>();
	return {
		cache,
		leaseCalls,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		upsertAuthCredentialForProviderIfAbsent() {
			return { inserted: false, reason: "skipped-existing", provider: "anthropic", entries: rows };
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		tryAcquireUsageFetchLease(key, owner, _nowMs, leaseMs) {
			leaseCalls.push(leaseMs);
			if (leaseOwners.has(key)) return false;
			leaseOwners.set(key, owner);
			return true;
		},
		releaseUsageFetchLease(key, owner) {
			if (leaseOwners.get(key) === owner) leaseOwners.delete(key);
		},
		cleanExpiredCache() {},
	};
}

function oauthRow(id: number, email: string): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: `oat-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${id}`,
		email,
	};
	return { id, provider: "anthropic", credential, disabledCause: null };
}

function makeReport(account: string): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour" },
				amount: { used: 42, limit: 100, unit: "percent" },
				status: "ok",
			},
		],
		metadata: { email: account, accountId: `account-${account}` },
	};
}

describe("AuthStorage usage probes across processes (gajae #5939/#5961)", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		store = makeStore([oauthRow(1, "a@example.com")]);
		// Only anthropic: other default providers would probe the network from env keys.
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		storage.close();
		vi.restoreAllMocks();
	});

	const anthropicOnly = (provider: string) => (provider === "anthropic" ? claudeUsage.claudeUsageProvider : undefined);

	async function openSharedDb(prefix: string): Promise<{ root: string; dbPath: string }> {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
		const dbPath = path.join(root, "agent.db");
		const seed = await SqliteAuthCredentialStore.open(dbPath);
		for (const id of ["a", "b"]) {
			seed.saveOAuth("anthropic", {
				access: `access-${id}`,
				refresh: `refresh-${id}`,
				expires: Date.now() + 3_600_000,
				accountId: `account-${id}`,
				email: `${id}@example.com`,
			});
		}
		seed.close();
		return { root, dbPath };
	}

	async function openProcess(dbPath: string): Promise<AuthStorage> {
		// A fresh store + AuthStorage on the same agent.db models a new `skc -p`.
		return AuthStorage.create(dbPath, { usageProviderResolver: anthropicOnly });
	}

	it("cools down a failure with no previous good value, then retries after the cool-down", async () => {
		let calls = 0;
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});

		const first = anthropicReports(await storage.fetchUsageReports());
		expect(first).toHaveLength(0);
		expect(calls).toBe(1);

		// No previous value → the failure itself is cooled down (#5939), so an
		// immediate re-poll does not re-hit a rate-limited endpoint.
		const second = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(1);
		expect(second).toHaveLength(0);

		// Once the cool-down expires the next poll retries the provider.
		expireCachePayloads(store);
		const third = anthropicReports(await storage.fetchUsageReports());
		expect(calls).toBe(2);
		expect(third).toHaveLength(0);
	});

	it("does not resurrect a last-good report older than the retention window on failure", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? goldReport : null;
		});

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		// Age the stored report past the 24h last-good retention while leaving the
		// row readable (expired rows are not swept and now survive startup).
		ageStoredReports(store, 25 * 60 * 60_000);

		// The probe fails; the ancient report must not come back as a fallback.
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect(calls).toBe(2);
	});

	it("repeated failures do not extend a last-good report past its retention", async () => {
		let calls = 0;
		const goldReport = makeReport("a@example.com");
		vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return calls === 1 ? goldReport : null;
		});

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		// 23h old: a failure still serves last-good, and rewrites the cool-down.
		ageStoredReports(store, 23 * 60 * 60_000);
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);
		expect(calls).toBe(2);

		// Another 2h of failures: the rewrite must not have renewed its age.
		ageStoredReports(store, 2 * 60 * 60_000);
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect(calls).toBe(3);
	});

	it("a new process reuses a peer's rate-limited probe instead of re-fetching usage", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-negative-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null; // e.g. the endpoint answered 429 on every attempt
		});
		const first = await openProcess(dbPath);
		let second: AuthStorage | undefined;
		try {
			expect(await first.getApiKey("anthropic", "session-1")).toBeDefined();
			expect(calls).toBe(2); // one probe per credential for ranking

			// Selecting again in the same process must not re-probe either.
			expect(await first.getApiKey("anthropic", "session-2")).toBeDefined();
			expect(calls).toBe(2);

			second = await openProcess(dbPath);
			expect(await second.getApiKey("anthropic", "session-3")).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			fetchSpy.mockRestore();
			first.close();
			second?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("a new process reuses a peer's successful report for ranking", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-positive-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			calls += 1;
			return makeReport(params.credential.email ?? "unknown");
		});
		const first = await openProcess(dbPath);
		let second: AuthStorage | undefined;
		try {
			await first.getApiKey("anthropic", "session-1");
			expect(calls).toBe(2);

			second = await openProcess(dbPath);
			await second.getApiKey("anthropic", "session-2");
			expect(calls).toBe(2);
		} finally {
			fetchSpy.mockRestore();
			first.close();
			second?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("concurrent processes single-flight each credential's usage probe", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-concurrent-");
		const gate = Promise.withResolvers<UsageReport | null>();
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return gate.promise;
		});
		const processes = await Promise.all([openProcess(dbPath), openProcess(dbPath), openProcess(dbPath)]);
		let selections: Promise<unknown>[] = [];
		try {
			selections = processes.map((storage, index) => storage.getApiKey("anthropic", `session-${index}`));
			await waitFor(() => calls === 2);
			await Bun.sleep(100);
			expect(calls).toBe(2);

			gate.resolve(null);
			for (const key of await Promise.all(selections)) expect(key).toBeDefined();
			expect(calls).toBe(2);
		} finally {
			gate.resolve(null);
			await Promise.allSettled(selections);
			fetchSpy.mockRestore();
			for (const storage of processes) storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cache-only probe mode ranks from a peer's cached reports without calling the provider", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-cache-only-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async params => {
			calls += 1;
			const report = makeReport(params.credential.email ?? "unknown");
			// Exhaust account a so ranking must prefer account b.
			if (params.credential.email === "a@example.com") report.limits[0]!.amount.used = 100;
			return report;
		});
		const printRun = await openProcess(dbPath);
		printRun.setUsageProbeMode("cache-only");
		let host: AuthStorage | undefined;
		try {
			// Cold cache: a print run selects a credential without any probe.
			expect(await printRun.getApiKey("anthropic", "print-1")).toMatch(/^access-/);
			expect(calls).toBe(0);

			// A long-lived host polls and caches reports in agent.db.
			host = await openProcess(dbPath);
			await host.fetchUsageReports();
			expect(calls).toBe(2);

			// A later print run ranks from those reports: exhausted a is skipped.
			const later = await openProcess(dbPath);
			later.setUsageProbeMode("cache-only");
			try {
				expect(await later.getApiKey("anthropic", "print-2")).toBe("access-b");
				expect(calls).toBe(2);
			} finally {
				later.close();
			}
		} finally {
			fetchSpy.mockRestore();
			printRun.close();
			host?.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cache-only probe mode never calls a store's network usage hook (broker-backed runs)", async () => {
		let hookCalls = 0;
		const store: AuthCredentialStore = {
			...makeStore([oauthRow(1, "a@example.com"), oauthRow(2, "b@example.com")]),
			// RemoteAuthCredentialStore implements this by fetching the broker's /v1/usage.
			getUsageReport: async () => {
				hookCalls += 1;
				return makeReport("a@example.com");
			},
		};
		const storage = new AuthStorage(store, { usageProviderResolver: anthropicOnly });
		await storage.reload();
		try {
			storage.setUsageProbeMode("cache-only");
			expect(await storage.getApiKey("anthropic", "broker-print")).toMatch(/^oat-/);
			expect(hookCalls).toBe(0);

			// Network mode still routes ranking through the store hook.
			storage.setUsageProbeMode("network");
			await storage.getApiKey("anthropic", "broker-interactive");
			expect(hookCalls).toBeGreaterThan(0);
		} finally {
			storage.close();
		}
	});

	it("re-probes after a credential change instead of reusing the old report", async () => {
		const { root, dbPath } = await openSharedDb("pi-ai-usage-5939-invalidate-");
		let calls = 0;
		const fetchSpy = vi.spyOn(claudeUsage.claudeUsageProvider, "fetchUsage").mockImplementation(async () => {
			calls += 1;
			return null;
		});
		const storage = await openProcess(dbPath);
		try {
			await storage.getApiKey("anthropic", "session-1");
			expect(calls).toBe(2);

			await storage.set("anthropic", [
				{
					type: "oauth",
					access: "access-c",
					refresh: "refresh-c",
					expires: Date.now() + 3_600_000,
					email: "c@example.com",
				},
				{
					type: "oauth",
					access: "access-d",
					refresh: "refresh-d",
					expires: Date.now() + 3_600_000,
					email: "d@example.com",
				},
			]);
			await storage.getApiKey("anthropic", "session-2");
			expect(calls).toBe(4);
		} finally {
			fetchSpy.mockRestore();
			storage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
