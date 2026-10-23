/**
 * Anthropic OAuth flow (Anthropic model Pro/Max)
 */
import { RecoveryAdmissionError } from "../recovery-budget";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials, OAuthRefreshOptions } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	opts?: Pick<OAuthRefreshOptions, "fetch" | "signal">,
): Promise<string> {
	const fetchFn = opts?.fetch ?? globalThis.fetch;
	const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
	const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
	const response = await fetchFn(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

/**
 * Decoded shape of Anthropic's `/v1/oauth/token` response (both
 * `authorization_code` exchange and `refresh_token` refresh return the same
 * envelope). The `account` and `organization` blocks are inlined alongside the
 * tokens, so we can surface `accountId` / `email` / `organizationId` on
 * {@link OAuthCredentials} without a separate `/api/oauth/profile` round-trip.
 */
interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
	organization?: { uuid?: string; name?: string };
}

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new Error(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Identity fields the token response carries; absent ones are omitted so a merge keeps the stored value. */
type AnthropicTokenIdentity = Pick<OAuthCredentials, "accountId" | "email" | "organizationId" | "organizationName">;

/**
 * Lift the OAuth response's `account: { uuid, email_address }` and
 * `organization: { uuid, name }` blocks onto {@link OAuthCredentials} so
 * downstream identity propagation (e.g. `metadata.user_id.account_uuid`, usage
 * tracking, one stored credential per organization) works without a separate
 * `/api/oauth/profile` round-trip. A field the response omits or carries as a
 * non-string / empty value is left out rather than set to `undefined`, so a
 * spread over a stored credential does not erase its organization.
 */
function extractIdentityFromTokenResponse(data: AnthropicTokenResponse): AnthropicTokenIdentity {
	const identity: AnthropicTokenIdentity = {};
	const accountId = nonEmptyString(data.account?.uuid);
	if (accountId) identity.accountId = accountId;
	const email = nonEmptyString(data.account?.email_address);
	if (email) identity.email = email;
	const organizationId = nonEmptyString(data.organization?.uuid);
	if (organizationId) identity.organizationId = organizationId;
	const organizationName = nonEmptyString(data.organization?.name);
	if (organizationName) identity.organizationName = organizationName;
	return identity;
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
		});
		const url = `${AUTHORIZE_URL}?${authParams.toString()}`;

		return {
			url,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		let responseBody: string;
		try {
			responseBody = await postJson(TOKEN_URL, {
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: exchangeCode,
				state: exchangeState,
				redirect_uri: redirectUri,
				code_verifier: this.#verifier,
			});
		} catch (error) {
			throw new Error(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
			);
		}

		const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			...extractIdentityFromTokenResponse(tokenData),
		};
	}
}

/**
 * Login with Anthropic OAuth
 */
export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(
	refreshToken: string,
	options?: OAuthRefreshOptions,
): Promise<OAuthCredentials> {
	options?.signal?.throwIfAborted();
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			options,
		);
	} catch (error) {
		if (error instanceof RecoveryAdmissionError || options?.signal?.aborted) throw error;
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		...extractIdentityFromTokenResponse(data),
	};
}
