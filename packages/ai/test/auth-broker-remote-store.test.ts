import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthStorage,
	type OAuthCredential,
	REMOTE_REFRESH_SENTINEL,
	RemoteAuthCredentialStore,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "../src";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		storage?.close();
		store?.close();
		await fs.rm(tempDir, { recursive: true, force: true });
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		storage!.upsertCredential("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = storage!.disableCredentialById(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("does not assign a lone usage report to another Anthropic organization", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		const teamCredential = {
			...mintOAuthCredential("shared", Date.now() + 60_000),
			accountId: "shared-account",
			email: "shared@example.com",
			organizationId: "org-team",
			organizationName: "Acme Team",
		};
		const personalCredential = {
			...teamCredential,
			access: "access-shared-personal",
			refresh: "refresh-shared-personal",
			organizationId: "org-personal",
			organizationName: "Personal Max",
		};
		storage!.upsertCredential("anthropic", teamCredential);
		storage!.upsertCredential("anthropic", personalCredential);
		await remote.refreshSnapshot();

		const teamEntry = remote.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.organizationId === "org-team",
		);
		const personalEntry = remote.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.organizationId === "org-personal",
		);
		if (teamEntry?.credential.type !== "oauth" || personalEntry?.credential.type !== "oauth") {
			throw new Error("expected broker snapshot to contain both Anthropic organizations");
		}
		expect(personalEntry.credential.organizationName).toBe("Personal Max");

		const now = Date.now();
		const teamReport = {
			provider: "anthropic" as const,
			fetchedAt: now,
			limits: [],
			metadata: { accountId: "shared-account", email: "shared@example.com", orgId: "org-team" },
		};
		const fetchUsage = vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [teamReport] });

		await expect(remote.getUsageReport("anthropic", teamEntry.credential)).resolves.toEqual(teamReport);
		await expect(remote.getUsageReport("anthropic", personalEntry.credential)).resolves.toBeNull();
		expect(fetchUsage).toHaveBeenCalledTimes(1);
	});

	describe("a credential stored without an organization", () => {
		const legacyCredential = {
			...mintOAuthCredential("shared", Date.now() + 60_000),
			accountId: "shared-account",
			email: "shared@example.com",
		};
		const teamCredential = {
			...legacyCredential,
			access: "access-shared-team",
			refresh: "refresh-shared-team",
			organizationId: "org-team",
			organizationName: "Acme Team",
		};
		const identity = { accountId: "shared-account", email: "shared@example.com" };

		async function seed(): Promise<{ client: AuthBrokerClient; legacy: OAuthCredential; team: OAuthCredential }> {
			const client = new AuthBrokerClient({ url: handle!.url, token });
			remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
			// Two rows of one account coexist: the org-less row predates organization tracking.
			storage!.upsertCredential("anthropic", legacyCredential);
			storage!.upsertCredential("anthropic", teamCredential);
			await remote.refreshSnapshot();
			const shared = remote.snapshot.credentials.filter(
				entry => entry.credential.type === "oauth" && entry.credential.accountId === "shared-account",
			);
			const legacy = shared.find(entry => entry.credential.type === "oauth" && !entry.credential.organizationId);
			const team = shared.find(entry => entry.credential.type === "oauth" && !!entry.credential.organizationId);
			if (legacy?.credential.type !== "oauth" || team?.credential.type !== "oauth") {
				throw new Error("expected broker snapshot to hold the legacy row and the Team row");
			}
			return { client, legacy: legacy.credential, team: team.credential };
		}

		test("does not take the lone report of an organization another row is scoped to", async () => {
			const { client, legacy, team } = await seed();
			const now = Date.now();
			// The legacy row's usage fetch failed, so the broker returns only the Team row's report.
			const teamReport = {
				provider: "anthropic" as const,
				fetchedAt: now,
				limits: [],
				metadata: { ...identity, orgId: "org-team" },
			};
			vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [teamReport] });

			await expect(remote!.getUsageReport("anthropic", legacy)).resolves.toBeNull();
			await expect(remote!.getUsageReport("anthropic", team)).resolves.toEqual(teamReport);
		});

		test("does not take another account's lone unclaimed report", async () => {
			const { client, legacy } = await seed();
			const now = Date.now();
			const otherAccountReport = {
				provider: "anthropic" as const,
				fetchedAt: now,
				limits: [],
				metadata: { accountId: "account-a", email: "a@example.com" },
			};
			vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [otherAccountReport] });

			await expect(remote!.getUsageReport("anthropic", legacy)).resolves.toBeNull();
		});

		test("still takes its own report, including one naming an organization no row claims", async () => {
			const { client, legacy, team } = await seed();
			const now = Date.now();
			// The Team row's fetch failed; the legacy row's report names its real, still-unrecorded organization.
			const legacyReport = {
				provider: "anthropic" as const,
				fetchedAt: now,
				limits: [],
				metadata: { ...identity, orgId: "org-personal" },
			};
			vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [legacyReport] });

			await expect(remote!.getUsageReport("anthropic", legacy)).resolves.toEqual(legacyReport);
			await expect(remote!.getUsageReport("anthropic", team)).resolves.toBeNull();
		});
	});

	test("takes the lone report without an identity match only when the provider has a single credential", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });
		await remote.refreshSnapshot();
		const [only] = remote.snapshot.credentials;
		if (only?.credential.type !== "oauth") throw new Error("expected the seeded oauth row");
		const now = Date.now();
		const anonymousReport = { provider: "anthropic" as const, fetchedAt: now, limits: [] };
		vi.spyOn(client, "fetchUsage").mockResolvedValue({ generatedAt: now, reports: [anonymousReport] });

		await expect(remote.getUsageReport("anthropic", only.credential)).resolves.toEqual(anonymousReport);
	});
});
