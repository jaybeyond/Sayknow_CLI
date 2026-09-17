/**
 * `skc auth-gateway` command handlers.
 *
 * Boots a forward-proxy server that lets less-trusted clients (the macOS
 * usage widget, local desktop apps and containerized deployments) make provider
 * API calls without ever seeing the access token.
 *
 * Credential source mirrors `discoverAuthStorage()` in sdk/session.ts:
 *   - broker configured (`SKC_AUTH_BROKER_URL` / `auth.broker.url`) → the
 *     gateway is a broker client and never touches local SQLite.
 *   - no broker → the local SQLite store at `<agentDir>/agent.db`, so a
 *     single-machine user runs the gateway alone instead of also standing up
 *     `skc auth-broker serve`.
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the gateway against the broker or local store.
 *   - `token` / `token --regenerate` — manages the gateway bearer token file.
 *   - `status` — prints the locally-stored gateway token and credential source.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	AuthBrokerClient,
	AuthStorage,
	DEFAULT_AUTH_GATEWAY_BIND,
	type GeneratedProvider,
	getBundledModels,
	getBundledProviders,
	type Model,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthGateway,
} from "@sayknow-cli/ai";
import { getAgentDbPath, getAgentDir, getConfigRootDir, isEnoent, VERSION } from "@sayknow-cli/utils";
import chalk from "chalk";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthGatewayAction = "serve" | "token" | "status" | "check";

export interface AuthGatewayCommandArgs {
	action: AuthGatewayAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		/**
		 * Disable bearer-token auth on inbound requests. Useful when the gateway
		 * is bound to loopback (the default `127.0.0.1:4000`) and you don't want
		 * to wire token-paste plumbing into every local client.
		 */
		noAuth?: boolean;
	};
}

const ACTIONS: readonly AuthGatewayAction[] = ["serve", "token", "status", "check"];

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.token");
}

async function readToken(): Promise<string | null> {
	try {
		const raw = await Bun.file(getTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeToken(token: string): Promise<void> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Atomically create the token file, refusing to clobber an existing one.
 * Returns `true` on success, `false` when the file already existed (so the
 * caller re-reads it instead of racing another concurrent `ensureToken`).
 */
async function createTokenExclusive(token: string): Promise<boolean> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		// `wx` = O_CREAT | O_EXCL — fails with EEXIST if the file is already there.
		await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	return true;
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	if (await createTokenExclusive(token)) return token;
	// Another concurrent invocation won the create race; read what they wrote.
	const fromRace = await readToken();
	if (fromRace) return fromRace;
	// File existed-then-disappeared between EEXIST and read; last resort, write
	// our generated token unconditionally so callers don't see an empty string.
	await writeToken(token);
	return token;
}

function createBrokerClient(brokerConfig: AuthBrokerClientConfig): AuthBrokerClient {
	return new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
}

async function fetchBrokerSnapshot(client: AuthBrokerClient): Promise<SnapshotResponse> {
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("Auth broker returned no initial snapshot");
	return result.snapshot;
}

/**
 * Credential source the gateway is serving from. `broker` mirrors the previous
 * behaviour; `local` is the single-machine path that makes `skc auth-broker
 * serve` optional.
 */
export interface GatewayCredentialSource {
	storage: AuthStorage;
	kind: "broker" | "local";
	/** Broker URL in broker mode, `null` in local mode. */
	brokerUrl: string | null;
	/** `<agentDir>/agent.db` in local mode, `null` in broker mode. */
	dbPath: string | null;
	/** `broker <url>` / `local <dbPath>` — also used as the AuthStorage sourceLabel. */
	label: string;
}

/**
 * Open the credential store the gateway should serve from.
 *
 * Same precedence as `discoverAuthStorage()` in sdk/session.ts: a configured
 * broker wins, otherwise fall back to the local SQLite store. Callers own the
 * returned `storage` and must `close()` it.
 */
export async function openGatewayCredentialSource(): Promise<GatewayCredentialSource> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (brokerConfig) {
		// Refresh + usage both flow through the store's broker hooks automatically —
		// `RemoteAuthCredentialStore.refreshOAuthCredential` and `.fetchUsageReports`.
		// AuthStorage discovers them when no explicit option overrides them, so the
		// gateway only needs to construct the store and pass it in.
		const client = createBrokerClient(brokerConfig);
		const initialSnapshot = await fetchBrokerSnapshot(client);
		const store = new RemoteAuthCredentialStore({ client, initialSnapshot });
		const label = `broker ${brokerConfig.url}`;
		const storage = new AuthStorage(store, { sourceLabel: label });
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
		return { storage, kind: "broker", brokerUrl: brokerConfig.url, dbPath: null, label };
	}
	const dbPath = getAgentDbPath(getAgentDir());
	const label = `local ${dbPath}`;
	// `AuthStorage.create` opens the store and reloads it in one step.
	const storage = await AuthStorage.create(dbPath, { sourceLabel: label });
	return { storage, kind: "local", brokerUrl: null, dbPath, label };
}

async function runServe(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const bind = flags.bind ?? DEFAULT_AUTH_GATEWAY_BIND;
	const gatewayToken = flags.noAuth ? null : await ensureToken();

	const source = await openGatewayCredentialSource();
	const storage = source.storage;

	// Build the model resolver + catalog from pi-ai's bundled metadata, scoped
	// to providers we hold credentials for. Format handlers ask `resolveModel`
	// to translate a client-requested `model` field into a pi-ai `Model<Api>`
	// before dispatch; `listModels` powers `/v1/models`.
	const snapshot = storage.exportSnapshot();
	const providersWithCreds = new Set<string>();
	for (const entry of snapshot.credentials) providersWithCreds.add(entry.provider);
	const modelById = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		if (!providersWithCreds.has(provider)) continue;
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			// First-write-wins so a canonical model id collisions across providers
			// stick to the provider listed first by getBundledProviders.
			if (!modelById.has(model.id)) modelById.set(model.id, model);
		}
	}

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelById.get(id),
		listModels: () => modelById.values(),
	});
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	if (gatewayToken) {
		process.stdout.write(`bearer token: ${getTokenFilePath()} (chmod 0600)\n`);
	} else {
		process.stdout.write(`auth: disabled (--no-auth) — any client can call this gateway\n`);
	}
	if (source.kind === "broker") {
		process.stdout.write(`upstream broker: ${source.brokerUrl}\n`);
	} else {
		process.stdout.write(`credentials: local ${source.dbPath}\n`);
	}

	const stopped = Promise.withResolvers<void>();
	let shutdownStarted = false;
	const stop = async (signal: NodeJS.Signals): Promise<void> => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		} finally {
			storage.close();
		}
		if (closeError) {
			stopped.reject(closeError);
		} else {
			stopped.resolve();
		}
	};
	const onSigint = (): void => {
		void stop("SIGINT");
	};
	const onSigterm = (): void => {
		void stop("SIGTERM");
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	try {
		await stopped.promise;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

async function runToken(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeToken(next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runStatus(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const token = await readToken();
	const tokenFile = getTokenFilePath();
	const tokenPresent = token !== null;

	let source: GatewayCredentialSource;
	try {
		source = await openGatewayCredentialSource();
	} catch (error) {
		// Broker unreachable, or the local SQLite store failed to open.
		const message = error instanceof Error ? error.message : String(error);
		const brokerConfig = await resolveAuthBrokerConfig().catch(() => null);
		const status = {
			ready: false,
			reason: brokerConfig ? "broker_unavailable" : "local_store_unavailable",
			source: brokerConfig ? "broker" : "local",
			tokenFile,
			tokenPresent,
			broker: brokerConfig?.url ?? null,
			brokerConfigured: brokerConfig !== null,
			brokerAuthenticated: false,
			dbPath: brokerConfig ? null : getAgentDbPath(getAgentDir()),
			error: message,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const what = brokerConfig ? `upstream broker: ${brokerConfig.url}` : `local store: ${status.dbPath}`;
			process.stdout.write(`${chalk.red("FAILED")} ${what}: ${message}\n`);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${tokenFile}\n`,
			);
		}
		process.exitCode = 1;
		return;
	}

	try {
		const credentialCount = source.storage.exportSnapshot().credentials.length;
		// Ready means a client can actually get an answer: it needs a bearer
		// token to present, and we need at least one provider credential to serve.
		const ready = tokenPresent && credentialCount > 0;
		const status = {
			ready,
			reason: !tokenPresent ? "token_missing" : credentialCount === 0 ? "no_credentials" : null,
			source: source.kind,
			tokenFile,
			tokenPresent,
			broker: source.brokerUrl,
			brokerConfigured: source.kind === "broker",
			brokerAuthenticated: source.kind === "broker",
			dbPath: source.dbPath,
			credentialCount,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const plural = credentialCount === 1 ? "" : "s";
			const sourceLine =
				source.kind === "broker"
					? `upstream broker: ${source.brokerUrl} (${credentialCount} credential${plural})`
					: `local store: ${source.dbPath} (${credentialCount} credential${plural})`;
			process.stdout.write(`${ready ? chalk.green("ready") : chalk.yellow("not ready")} ${sourceLine}\n`);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${tokenFile}\n`,
			);
			if (!tokenPresent) {
				process.stdout.write(
					"Run `skc auth-gateway token` or `skc auth-gateway serve` to create a bearer token.\n",
				);
			}
			if (credentialCount === 0) {
				process.stdout.write(
					source.kind === "broker"
						? "The broker holds no credentials. Log in on the broker host.\n"
						: "No local credentials. Run `skc auth-broker login <provider>` (e.g. anthropic).\n",
				);
			}
		}
		if (!ready) process.exitCode = 1;
	} finally {
		source.storage.close();
	}
}

export async function runAuthGatewayCommand(cmd: AuthGatewayCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "check":
			await runCheck(cmd.flags);
			return;
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

/**
 * `skc auth-gateway check` — probe each credential the gateway would serve and
 * print per-credential auth health. Use this when the gateway is returning 401s
 * you need to find which row in a multi-account pool is the bad one. The
 * aggregate `/v1/usage` endpoint silently drops failed credentials, so a
 * dedicated diagnostic is the only way to see which credentials failed.
 */
async function runCheck(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const source = await openGatewayCredentialSource();
	const storage = source.storage;
	try {
		const results = await storage.checkCredentials();

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({ source: source.kind, broker: source.brokerUrl, dbPath: source.dbPath, credentials: results }, null, 2)}\n`,
			);
		} else {
			const grouped = new Map<string, typeof results>();
			for (const row of results) {
				const list = grouped.get(row.provider) ?? [];
				list.push(row);
				grouped.set(row.provider, list);
			}
			const providers = [...grouped.keys()].sort();
			process.stdout.write(`${source.label}\n`);
			for (const provider of providers) {
				const rows = grouped.get(provider) ?? [];
				process.stdout.write(`\n${chalk.bold(provider)} (${rows.length})\n`);
				for (const row of rows) {
					const status =
						row.ok === true
							? chalk.green("ok      ")
							: row.ok === false
								? chalk.red("FAIL    ")
								: chalk.yellow("unknown ");
					const identity =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					const remote = row.remoteRefresh ? chalk.dim(" [remote-refresh]") : "";
					const reason = row.reason ? chalk.dim(` — ${row.reason}`) : "";
					process.stdout.write(
						`  ${status} id=${row.id.toString().padStart(3)} ${row.type.padEnd(7)} ${identity}${remote}${reason}\n`,
					);
				}
			}
			const failed = results.filter(row => row.ok === false).length;
			const unverifiable = results.filter(row => row.ok === null).length;
			const passing = results.filter(row => row.ok === true).length;
			process.stdout.write(
				`\n${chalk.green(`${passing} ok`)}, ${chalk.red(`${failed} failed`)}, ${chalk.yellow(`${unverifiable} unverifiable`)}, ${results.length} total\n`,
			);
			if (failed > 0) process.exitCode = 1;
		}
	} finally {
		storage.close();
	}
}

export { ACTIONS as AUTH_GATEWAY_ACTIONS };
