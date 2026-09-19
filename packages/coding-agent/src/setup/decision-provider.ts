/**
 * Store a TypeSafe key so the typed-decision service can use the hosted model.
 *
 * TypeSafe is **not** a chat provider: no streaming, no messages, no text output. So it
 * must not be written into `models.yml` the way `addApiCompatibleProvider` writes
 * OpenAI-compatible endpoints — that would invent a chat model that cannot answer a
 * chat request and would show up in the model picker as something users could select.
 *
 * Only the credential is stored. The decision backend reads it through the same
 * `getApiKeyForProvider` path every other provider uses, so adding a key turns the
 * backend on and removing it turns the backend off, with nothing else to configure.
 */
import { AuthStorage } from "@sayknow-cli/ai";
import { getAgentDbPath } from "@sayknow-cli/utils";
import { TYPESAFE_PROVIDER } from "../decisions";

const VERIFY_ENDPOINT = "https://api.typesafe.ai/v1/models";
const VERIFY_TIMEOUT_MS = 10_000;

export interface TypeSafeKeySetupResult {
	provider: string;
	verified: boolean;
	/** Present when verification ran and failed; the key is not stored in that case. */
	error?: string;
}

/**
 * Verify a key against the live API before storing it.
 *
 * Storing an unverified key is worse than refusing it: the decision service fails open,
 * so a bad key produces no error anywhere — it silently falls back to the user's own
 * model forever, and the user believes TypeSafe is active.
 */
export async function verifyTypeSafeKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
	try {
		const response = await fetchImpl(VERIFY_ENDPOINT, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (response.ok) return null;
		if (response.status === 401 || response.status === 403) return "key rejected by TypeSafe (401/403)";
		return `TypeSafe returned ${response.status}`;
	} catch (error) {
		return `could not reach TypeSafe: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		clearTimeout(timer);
	}
}

export interface SetTypeSafeKeyOptions {
	apiKey: string;
	/** Skip the live check. Only for offline setup; the key may be wrong. */
	skipVerify?: boolean;
	fetchImpl?: typeof fetch;
	dbPath?: string;
}

export async function setTypeSafeKey(options: SetTypeSafeKeyOptions): Promise<TypeSafeKeySetupResult> {
	const apiKey = options.apiKey.trim();
	if (!apiKey) throw new Error("TypeSafe API key must not be empty");

	let verified = false;
	if (!options.skipVerify) {
		const failure = await verifyTypeSafeKey(apiKey, options.fetchImpl ?? fetch);
		if (failure) return { provider: TYPESAFE_PROVIDER, verified: false, error: failure };
		verified = true;
	}

	const authStorage = await AuthStorage.create(options.dbPath ?? getAgentDbPath());
	try {
		await authStorage.set(TYPESAFE_PROVIDER, { type: "api_key", key: apiKey });
	} finally {
		authStorage.close();
	}
	return { provider: TYPESAFE_PROVIDER, verified };
}

export async function removeTypeSafeKey(dbPath?: string): Promise<void> {
	const authStorage = await AuthStorage.create(dbPath ?? getAgentDbPath());
	try {
		await authStorage.remove(TYPESAFE_PROVIDER);
	} finally {
		authStorage.close();
	}
}

export function formatTypeSafeKeyResult(result: TypeSafeKeySetupResult): string {
	if (result.error) return `✗ TypeSafe key not stored: ${result.error}`;
	return result.verified
		? "✓ TypeSafe key verified and stored. Typed decisions will use the hosted model."
		: "✓ TypeSafe key stored (unverified). Typed decisions will try the hosted model.";
}
