import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	formatOAuthIdentityLabel,
	type OAuthCredential,
	SqliteAuthCredentialStore,
	selectOrganizationMatches,
} from "../src/auth-storage";
import { claudeUsageProvider } from "../src/usage/claude";
import { refreshAnthropicToken } from "../src/utils/oauth/anthropic";

const EMAIL = "user@example.com";
const ACCOUNT = "account-uuid";
const TEAM = { uuid: "org-team", name: "Acme Team" };
const PERSONAL = { uuid: "org-personal", name: "Personal Max" };

type Organization = { uuid: string; name: string };

const originalFetch = global.fetch;

function tokenResponse(organization: Organization | undefined, suffix: string): Response {
	return new Response(
		JSON.stringify({
			access_token: `access-${suffix}`,
			refresh_token: `refresh-${suffix}`,
			expires_in: 3600,
			account: { uuid: ACCOUNT, email_address: EMAIL },
			...(organization ? { organization } : {}),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function readRows(dbPath: string): Array<{ id: number; identity_key: string | null }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT id, identity_key FROM auth_credentials WHERE provider = 'anthropic' AND disabled_cause IS NULL ORDER BY id",
			)
			.all() as Array<{ id: number; identity_key: string | null }>;
	} finally {
		db.close();
	}
}

describe("AuthStorage anthropic organizations", () => {
	let tempDir = "";
	let dbPath = "";
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "skc-anthropic-orgs-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			// Resolve per call: each test swaps `global.fetch` after construction.
			usageFetch: ((input: string | URL | Request, init?: RequestInit) => global.fetch(input, init)) as typeof fetch,
		});
	});

	afterEach(async () => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** A login's stored result: the parsed token response, persisted the way login and the broker upload do. */
	async function login(organization: Organization | undefined, suffix: string): Promise<void> {
		global.fetch = vi.fn(async () => tokenResponse(organization, suffix)) as unknown as typeof fetch;
		const credentials = await refreshAnthropicToken(`seed-${suffix}`);
		authStorage.upsertCredential("anthropic", { type: "oauth", ...credentials });
	}

	function activeOrganizations(): Array<string | undefined> {
		return store
			.listAuthCredentials("anthropic")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.organizationId : undefined));
	}

	it("keeps one credential per organization for the same account", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");

		expect(activeOrganizations()).toEqual([TEAM.uuid, PERSONAL.uuid]);
		expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
			`email:${EMAIL}|org:${TEAM.uuid}`,
			`email:${EMAIL}|org:${PERSONAL.uuid}`,
		]);
		const names = store
			.listAuthCredentials("anthropic")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.organizationName : undefined));
		expect(names).toEqual([TEAM.name, PERSONAL.name]);
	});

	it("replaces the credential when the same organization logs in again", async () => {
		await login(TEAM, "team-1");
		await login(PERSONAL, "personal");
		await login(TEAM, "team-2");

		const active = store.listAuthCredentials("anthropic");
		expect(active).toHaveLength(2);
		const team = active.find(
			entry => entry.credential.type === "oauth" && entry.credential.organizationId === TEAM.uuid,
		);
		expect(team?.credential.type === "oauth" ? team.credential.access : undefined).toBe("access-team-2");
	});

	it("still replaces by account when the token response carries no organization", async () => {
		await login(undefined, "first");
		await login(undefined, "second");

		const active = store.listAuthCredentials("anthropic");
		expect(active).toHaveLength(1);
		expect(active[0]?.credential.type === "oauth" ? active[0].credential.access : undefined).toBe("access-second");
		expect(readRows(dbPath).map(row => row.identity_key)).toEqual([`email:${EMAIL}`]);
	});

	describe("a row stored before organizations were tracked", () => {
		const legacy: OAuthCredential = {
			type: "oauth",
			access: "access-legacy",
			refresh: "refresh-legacy",
			expires: Date.now() + 60_000,
			accountId: ACCOUNT,
			email: EMAIL,
		};

		async function seedLegacyThenLogin(organization: Organization): Promise<number> {
			const [stored] = store.upsertAuthCredentialForProvider("anthropic", legacy);
			await authStorage.reload();
			await login(organization, "login");
			expect(readRows(dbPath).map(row => row.identity_key)).toEqual([
				`email:${EMAIL}`,
				`email:${EMAIL}|org:${organization.uuid}`,
			]);
			return stored?.id ?? -1;
		}

		async function refreshLegacyCredential(legacyId: number, organization: Organization, suffix: string) {
			const expired = { ...legacy, expires: Date.now() - 60_000 };
			store.updateAuthCredential(legacyId, expired);
			await authStorage.reload();
			global.fetch = vi.fn(async () => tokenResponse(organization, suffix)) as unknown as typeof fetch;
			await authStorage.forceRefreshOAuthCredential("anthropic", expired);
		}

		it("refreshes a legacy row into a different organization without replacing the known one", async () => {
			const legacyId = await seedLegacyThenLogin(TEAM);
			await refreshLegacyCredential(legacyId, PERSONAL, "legacy-personal");

			expect(activeOrganizations()).toEqual([PERSONAL.uuid, TEAM.uuid]);
		});

		it("deduplicates a legacy row immediately when refresh names the same organization", async () => {
			const legacyId = await seedLegacyThenLogin(TEAM);
			await refreshLegacyCredential(legacyId, TEAM, "legacy-team");

			const active = store.listAuthCredentials("anthropic");
			expect(active).toHaveLength(1);
			expect(active[0]?.id).toBe(legacyId);
			expect(active[0]?.credential.type === "oauth" ? active[0].credential.organizationId : undefined).toBe(
				TEAM.uuid,
			);
			expect(readRows(dbPath).map(row => row.identity_key)).toEqual([`email:${EMAIL}|org:${TEAM.uuid}`]);
		});

		it("keeps the stored organization when a refresh response omits it", async () => {
			await login(TEAM, "team");
			const [stored] = store.listAuthCredentials("anthropic");
			if (stored?.credential.type !== "oauth") throw new Error("expected stored oauth row");
			const expired = { ...stored.credential, expires: Date.now() - 60_000 };
			store.updateAuthCredential(stored.id, expired);
			await authStorage.reload();
			global.fetch = vi.fn(async () => tokenResponse(undefined, "no-org")) as unknown as typeof fetch;
			await authStorage.forceRefreshOAuthCredential("anthropic", expired);

			expect(activeOrganizations()).toEqual([TEAM.uuid]);
			expect(readRows(dbPath).map(row => row.identity_key)).toEqual([`email:${EMAIL}|org:${TEAM.uuid}`]);
		});
	});

	describe("org: selectors", () => {
		it("selects by organization id or display name", async () => {
			await login(TEAM, "team");
			await login(PERSONAL, "personal");

			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: PERSONAL.uuid });
			expect(await authStorage.getApiKey("anthropic", "session-1")).toBe("access-personal");
			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: "acme team" });
			expect(await authStorage.getApiKey("anthropic", "session-1")).toBe("access-team");
		});

		it("rejects a shared organization name instead of using the first row", async () => {
			await login({ uuid: "org-first", name: "Acme" }, "first");
			await login({ uuid: "org-second", name: "Acme" }, "second");
			const ids = store.listAuthCredentials("anthropic").map(entry => entry.id);
			expect(ids).toHaveLength(2);

			expect(() => authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: "Acme" })).toThrow(
				new RegExp(`matches multiple .*ids: ${ids.join(", ")}`),
			);
		});

		it("prefers an exact organization id over another organization named like it", async () => {
			await login({ uuid: "org-first", name: "First" }, "first");
			await login({ uuid: "org-impostor", name: "org-first" }, "impostor");

			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: "org-first" });
			expect(await authStorage.getApiKey("anthropic", "session-1")).toBe("access-first");
		});

		it("fails a pinned selector at request time once a later login makes it ambiguous", async () => {
			await login({ uuid: "org-first", name: "Acme" }, "first");
			authStorage.setRuntimeCredentialSelector("anthropic", { kind: "org", value: "Acme" });
			expect(await authStorage.getApiKey("anthropic", "session-1")).toBe("access-first");

			await login({ uuid: "org-second", name: "Acme" }, "second");
			await expect(authStorage.getApiKey("anthropic", "session-1")).rejects.toThrow(/matches multiple/);
		});

		it("selectOrganizationMatches returns every name match when no id matches exactly", () => {
			const rows = [
				{ organizationId: "a", organizationName: "Shared" },
				{ organizationId: "b", organizationName: "shared" },
				{ organizationId: "c", organizationName: "Other" },
			];
			expect(selectOrganizationMatches(rows, "SHARED", row => row).map(row => row.organizationId)).toEqual([
				"a",
				"b",
			]);
			expect(selectOrganizationMatches(rows, "c", row => row).map(row => row.organizationId)).toEqual(["c"]);
			expect(selectOrganizationMatches(rows, "  ", row => row)).toEqual([]);
		});
	});

	it("labels each organization's credential", async () => {
		await login(TEAM, "team");

		expect(authStorage.describeCredentialSource("anthropic")).toContain(`(${EMAIL} (${TEAM.name}))`);
		expect(formatOAuthIdentityLabel({ email: EMAIL })).toBe(EMAIL);
		expect(formatOAuthIdentityLabel({ organizationName: TEAM.name })).toBe(TEAM.name);
	});

	it("reports usage per organization instead of merging the shared account", async () => {
		await login(TEAM, "team");
		await login(PERSONAL, "personal");
		const utilizationByToken: Record<string, number> = { "Bearer access-team": 80, "Bearer access-personal": 5 };
		global.fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization") ?? "";
			const utilization = utilizationByToken[authorization];
			if (utilization === undefined) return new Response("unauthorized", { status: 401 });
			return new Response(
				JSON.stringify({
					five_hour: { utilization, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
					seven_day: { utilization: 1, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const reports = (await authStorage.fetchUsageReports())?.filter(report => report.provider === "anthropic") ?? [];
		const byOrganization = Object.fromEntries(
			reports.map(report => [
				report.metadata?.orgId,
				report.limits.find(limit => limit.id === "anthropic:5h")?.amount.used,
			]),
		);
		expect(byOrganization).toEqual({ [TEAM.uuid]: 80, [PERSONAL.uuid]: 5 });
	});
});
