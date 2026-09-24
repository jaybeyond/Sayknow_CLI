/**
 * Credential store discovery, on its own so a short-lived process can open the
 * store without importing the SDK.
 *
 * `sdk/session.ts` re-exports `discoverAuthStorage` and remains the public entry
 * point. Measured: importing `sdk/session` costs ~400ms of module graph; the
 * Codex prompt hook runs once per prompt and already spends 260ms, so it opens
 * credentials through this file instead.
 */
import { getAgentDbPath, getAgentDir } from "@sayknow-cli/utils";
import { resolveConfigValue } from "../config/resolve-config-value";
import { resolveAuthBrokerConfig } from "./auth-broker-config";
import { AuthBrokerClient, AuthStorage, RemoteAuthCredentialStore } from "./auth-storage";

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `SKC_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 */
export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	const brokerConfig = await resolveAuthBrokerConfig();
	const credentialRankingMode = resolveCredentialRankingMode();
	if (brokerConfig) {
		const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("Auth broker returned no initial snapshot");
		const store = new RemoteAuthCredentialStore({ client, initialSnapshot: initialResult.snapshot });
		// Refresh + usage hooks live on RemoteAuthCredentialStore; AuthStorage
		// discovers them automatically when no explicit option overrides them.
		const storage = new AuthStorage(store, {
			configValueResolver: resolveConfigValue,
			sourceLabel: `broker ${brokerConfig.url}`,
			credentialRankingMode,
		});
		try {
			await storage.reload();
		} catch (error) {
			try {
				storage.close();
			} catch {
				// Preserve the initial reload failure.
			}
			throw error;
		}
		return storage;
	}
	const dbPath = getAgentDbPath(agentDir);
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: resolveConfigValue,
		sourceLabel: `local ${dbPath}`,
		credentialRankingMode,
	});
	try {
		await storage.reload();
	} catch (error) {
		try {
			storage.close();
		} catch {
			// Preserve the initial reload failure.
		}
		throw error;
	}
	return storage;
}

/**
 * Opt-in multi-account credential ranking mode, read from the
 * `SKC_CREDENTIAL_RANKING_MODE` env var. Unset/unknown → `undefined`, leaving
 * {@link AuthStorage}'s default (`balanced`) untouched. `earliest-reset`
 * switches to earliest-expiry-first selection so soon-to-reset tumbling-window
 * quota is drained before it is lost.
 */
function resolveCredentialRankingMode(): "balanced" | "earliest-reset" | undefined {
	const raw = process.env.SKC_CREDENTIAL_RANKING_MODE?.trim();
	if (raw === "balanced" || raw === "earliest-reset") return raw;
	return undefined;
}
