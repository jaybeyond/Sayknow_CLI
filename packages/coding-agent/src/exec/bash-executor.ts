/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import * as fs from "node:fs/promises";
import { executeShell, type MinimizerOptions, Shell } from "@sayknow-cli/natives";
import { postmortem } from "@sayknow-cli/utils";
import { projectDeclaredSpawnHookNames, stripProjectSpawnHooks } from "@sayknow-cli/utils/shell-config";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { formatCrashDiagnosticNotice, writeCrashReport } from "../debug/crash-diagnostics";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

export interface BashExecutorOptions {
	cwd?: string;
	timeout?: number | null;
	onChunk?: (chunk: string) => void;
	/**
	 * Unthrottled per-chunk callback that fires for every sanitized stdout/stderr
	 * chunk *before* preview throttling. Background-job substrate uses this to
	 * record the complete process stream for the Monitor tool while keeping
	 * `onChunk` cheap for UI/progress rendering.
	 */
	onRawChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Session settings used for shell policy; defaults to the process settings. */
	settings?: Settings;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Environment variable names to remove for this command only. Explicit `env` values win. */
	unsetEnv?: string[];
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/** Execute without retaining a native Shell in the persistent session registry. */
	oneShot?: boolean;
	/** Ignore user-configured shell command prefixes. Used by constrained read-only shells. */
	ignoreShellPrefix?: boolean;
	/** Skip sourced shell snapshots. Used by constrained read-only shells. */
	disableShellSnapshot?: boolean;
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). The returned id is spliced into
	 * the sink output as `artifact://<id>` so the agent can retrieve the raw
	 * bytes. Return `undefined` to skip the footer.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const retiringShellSessions = new Set<Shell>();
// Cover pi-shell's normal cancellation kill waves without turning a stalled
// native cleanup into a multi-second JavaScript tool stall.
const CANCEL_CLEANUP_WAIT_MS = 400;

/** Number of persistent shell sessions currently retained (owner gauge). */
export function getShellSessionCount(): number {
	return shellSessions.size;
}

/**
 * Dispose all persistent shell sessions: abort in-flight work and drop the
 * strong references so the native shells can be finalized. Healthy persistent
 * sessions are otherwise retained for the whole process lifetime (MEM-7). This
 * is registered as a postmortem cleanup so shutdown/signals release native
 * shell resources, and is also callable directly (e.g. on owner teardown).
 */
export async function disposeAllShellSessions(): Promise<void> {
	// Snapshot and drop strong references up front so concurrent callers cannot
	// reuse a session that is being torn down, then await every native abort so
	// shutdown/signal cleanup does not return before resources are released.
	// Include retiring shells whose JS call returned after bounded abort cleanup
	// while the native run is still unwinding; they are no longer reusable but
	// remain owned until their run promise settles.
	const sessions = new Set([...shellSessions.values(), ...retiringShellSessions]);
	shellSessions.clear();
	retiringShellSessions.clear();
	brokenShellSessions.clear();
	await Promise.allSettled([...sessions].map(session => session.abort()));
}

postmortem.register("bash-executor:shell-sessions", () => disposeAllShellSessions());

async function resolveShellCwd(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) return undefined;

	try {
		// Brush preserves the working directory string verbatim, so resolve symlinks
		// up front to keep `pwd` aligned with tools like `git worktree list`.
		return await fs.realpath(cwd);
	} catch {
		return cwd;
	}
}

function presentMinimizerString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

type ShellMinimizerSource = {
	getGroup(prefix: "shellMinimizer"): ShellMinimizerSettings;
	getGlobal?(path: "shellMinimizer.settingsPath" | "shellMinimizer.settingsHash"): unknown;
	getOverride?(path: "shellMinimizer.settingsPath"): unknown;
};

/**
 * A repo `.skc/settings.json` must not point the minimizer at a TOML file.
 * The native gate loads that file only when `settingsHash` matches, and the
 * pin is the user/global value. A user path or a runtime override is still
 * passed through. A project path is passed only together with that pin.
 */
export function resolveTrustedShellMinimizer(settings: ShellMinimizerSource): ShellMinimizerSettings {
	const group = settings.getGroup("shellMinimizer");
	const globalPath =
		typeof settings.getGlobal === "function"
			? presentMinimizerString(settings.getGlobal("shellMinimizer.settingsPath"))
			: undefined;
	const globalHash =
		typeof settings.getGlobal === "function"
			? presentMinimizerString(settings.getGlobal("shellMinimizer.settingsHash"))
			: undefined;
	const overridePath =
		typeof settings.getOverride === "function"
			? presentMinimizerString(settings.getOverride("shellMinimizer.settingsPath"))
			: undefined;
	const effectivePath = presentMinimizerString(group.settingsPath);

	let settingsPath: string | undefined;
	if (overridePath && effectivePath === overridePath) {
		settingsPath = overridePath;
	} else if (globalPath) {
		settingsPath = globalPath;
	} else if (effectivePath && globalHash) {
		settingsPath = effectivePath;
	}

	// A runtime override of a different path is operator input, not the file the
	// user hash pins. Every other admitted path is checked with that pin.
	const unpinnedOverride = overridePath !== undefined && settingsPath === overridePath && settingsPath !== globalPath;
	return {
		...group,
		settingsPath,
		settingsHash: globalHash && settingsPath && !unpinnedOverride ? globalHash : undefined,
	};
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	const settingsPath = group.settingsPath || undefined;
	const settingsHash = settingsPath && group.settingsHash ? group.settingsHash : undefined;
	return {
		enabled: true,
		settingsPath,
		...(settingsHash ? { settingsHash } : {}),
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
	};
}

function projectHookUnsetEnv(
	unsetEnv: string[] | undefined,
	env: Record<string, string> | undefined,
	sessionEnv: Record<string, string>,
): string[] | undefined {
	// Keys present in `sessionEnv` (e.g. the trusted HOME replacement) already
	// override the ambient import, so only shadow the ones it does not carry.
	const hooks = projectDeclaredSpawnHookNames().filter(
		name => !Object.hasOwn(env ?? {}, name) && !Object.hasOwn(sessionEnv, name),
	);
	if (hooks.length === 0) return unsetEnv;
	return [...(unsetEnv ?? []), ...hooks.filter(name => !unsetEnv?.includes(name))];
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = options?.settings ?? (await Settings.init());
	const { shell, env: configEnv, prefix } = settings.getShellConfig();
	// The shell config env is shared with other consumers (Python kernels keep
	// their own documented allowlist). Only the bash tool's shell must not see
	// project hook variables such as GIT_CONFIG_* or NODE_OPTIONS.
	const shellEnv = stripProjectSpawnHooks({ ...configEnv });
	const configuredPrefix = options?.ignoreShellPrefix ? undefined : prefix;
	const snapshotPath =
		!options?.disableShellSnapshot && shell.includes("bash") ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(resolveTrustedShellMinimizer(settings));

	const commandCwd = await resolveShellCwd(options?.cwd);
	const commandEnv = options?.env ? { ...NON_INTERACTIVE_ENV, ...options.env } : NON_INTERACTIVE_ENV;
	// The native shell runs in-process and imports the host environment, which
	// holds the autoloaded project `.env`, before `sessionEnv`. Shadow project
	// hook variables per run unless this call sets them explicitly.
	const unsetEnv = projectHookUnsetEnv(options?.unsetEnv, options?.env, shellEnv);

	// Apply command prefix if configured and allowed for this execution.
	const prefixedCommand = configuredPrefix ? `${configuredPrefix} ${command}` : command;
	const finalCommand = prefixedCommand;

	// Create output sink for truncation and artifact handling
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		onRawChunk: options?.onRawChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		// Throttle the streaming preview callback to avoid saturating the
		// event loop when commands produce massive output (e.g. seq 1 50M).
		chunkThrottleMs: options?.onChunk ? 50 : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump("Command cancelled")),
		};
	}

	const usePersistentShell = options?.oneShot !== true;
	const sessionKey = buildSessionKey(shell, configuredPrefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const persistentSessionBroken = usePersistentShell && brokenShellSessions.has(sessionKey);

	let shellSession = persistentSessionBroken || !usePersistentShell ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken && usePersistentShell) {
		shellSession = new Shell({
			sessionEnv: shellEnv,
			snapshotPath: snapshotPath ?? undefined,
			minimizer,
		});
		shellSessions.set(sessionKey, shellSession);
	}
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		if (shellSession && !abortPromise) {
			abortPromise = shellSession.abort();
		}
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	let abortPromise: Promise<unknown> | undefined;
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	const awaitAbortCleanup = async (runPromise: Promise<unknown>): Promise<boolean> => {
		const settled = await Promise.race([
			runPromise.then(
				() => true,
				() => true,
			),
			Bun.sleep(CANCEL_CLEANUP_WAIT_MS).then(() => false),
		]);
		if (abortPromise) {
			await Promise.race([abortPromise.catch(() => undefined), Bun.sleep(CANCEL_CLEANUP_WAIT_MS)]);
		}
		return settled;
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const executionTimeoutMs = options?.timeout === null ? undefined : (options?.timeout ?? 300_000);
	const baseTimeoutMs = executionTimeoutMs === undefined ? undefined : Math.max(1_000, executionTimeoutMs);
	if (baseTimeoutMs !== undefined) {
		timeoutTimer = setTimeout(() => {
			abortCurrentExecution();
			timeoutDeferred.resolve("timeout");
		}, baseTimeoutMs);
	}

	let resetSession = false;
	let runSettled = false;

	try {
		const runPromise = shellSession
			? shellSession.run(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						unsetEnv,
						timeoutMs: executionTimeoutMs,
						signal: runAbortController.signal,
					},
					(err, chunk) => {
						if (!err) {
							enqueueChunk(chunk);
						}
					},
				)
			: executeShell(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						unsetEnv,
						sessionEnv: shellEnv,
						snapshotPath: snapshotPath ?? undefined,
						minimizer,
						timeoutMs: executionTimeoutMs,
						signal: runAbortController.signal,
					},
					(err, chunk) => {
						if (!err) {
							enqueueChunk(chunk);
						}
					},
				);

		const winner = await Promise.race([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			if (shellSession) {
				resetSession = true;
				retiringShellSessions.add(shellSession);
				brokenShellSessions.add(sessionKey);
				shellSessions.delete(sessionKey);
				runSettled = await awaitAbortCleanup(runPromise);
				if (runSettled) {
					brokenShellSessions.delete(sessionKey);
					retiringShellSessions.delete(shellSession);
				} else {
					void runPromise
						.finally(() => {
							brokenShellSessions.delete(sessionKey);
							retiringShellSessions.delete(shellSession);
							if (shellSessions.get(sessionKey) === shellSession) {
								shellSessions.delete(sessionKey);
							}
						})
						.catch(() => undefined);
				}
			} else {
				void runPromise.catch(() => undefined);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(
					winner.kind === "timeout" && baseTimeoutMs !== undefined
						? `Command timed out after ${Math.round(baseTimeoutMs / 1000)} seconds`
						: "Command cancelled",
				)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		// Handle timeout
		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(annotation)),
			};
		}

		// Handle cancellation
		if (winner.result.cancelled) {
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
			};
		}

		// When the native minimizer rewrote the output, swap the sink's accumulated
		// raw stream for the minimized text, persist the original as a session
		// artifact, and splice an `artifact://<id>` footer into the visible text so
		// the agent can retrieve the raw bytes losslessly.
		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text);
			if (options?.onMinimizedSave) {
				const artifactId = await options.onMinimizedSave(minimized.originalText, {
					filter: minimized.filter,
					inputBytes: minimized.inputBytes,
					outputBytes: minimized.outputBytes,
				});
				if (artifactId) {
					const sep = minimized.text.endsWith("\n") ? "" : "\n";
					sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
				}
			}
		}

		const crashReport = await writeCrashReport(
			{
				kind: "bash",
				command: [shell, "-lc", finalCommand],
				exitCode: winner.result.exitCode,
				stderr: undefined,
			},
			{ cwd: commandCwd },
		);
		const crashNotice = formatCrashDiagnosticNotice(crashReport);
		if (crashNotice) {
			const separator = "\n";
			sink.push(`${separator}${crashNotice}\n`);
		}

		// Normal completion
		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (resetSession && runSettled && shellSessions.get(sessionKey) === shellSession) {
			shellSessions.delete(sessionKey);
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}
