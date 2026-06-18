/**
 * Centralized path helpers for sayknow-cli config directories.
 *
 * Uses PI_CONFIG_DIR (default ".skc") for the config root and
 * PI_CODING_AGENT_DIR to override the agent directory.
 *
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME environment
 * variables are set, paths are redirected to XDG-compliant locations under
 * $XDG_*_HOME/skc/. This requires running `skc config migrate` first to
 * move data to the new locations. No filesystem existence checks are performed
 * — if the env var is set, skc trusts that the migration has been done.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engines, version } from "../package.json" with { type: "json" };

/** App name (e.g. "skc") */
export const APP_NAME: string = "skc";

/** Config directory name (e.g. ".skc") */
export const CONFIG_DIR_NAME: string = ".skc";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

/**
 * Build the diagnostic shown when the Bun runtime executing `skc` is older
 * than {@link MIN_BUN_VERSION}. This is the most common Windows native-install
 * failure (issue #525): `bun install -g sayknow-cli` probes a recent Bun while
 * the `skc` launcher resolves an older Bun still on PATH. The message names the
 * exact detected runtime path and gives a platform-specific upgrade + PATH fix
 * instead of a bare `bun upgrade`.
 *
 * Pure and platform-parameterized so it can be unit-tested cross-platform.
 */
export function formatBunRuntimeError(opts: {
	currentVersion: string;
	minVersion: string;
	execPath?: string;
	platform?: NodeJS.Platform;
}): string {
	const platform = opts.platform ?? process.platform;
	const lines = [
		`error: ${APP_NAME} requires Bun >= ${opts.minVersion}, but the running Bun is v${opts.currentVersion}.`,
	];
	if (opts.execPath) {
		lines.push(`  detected Bun runtime: ${opts.execPath}`);
	}
	if (platform === "win32") {
		lines.push(
			"",
			"The 'skc' launcher is using an older Bun than the one used to install it.",
			"Upgrade Bun, then restart your terminal so PATH and the runtime refresh:",
			"",
			'  powershell -c "irm bun.sh/install.ps1|iex"',
			"",
			"After restarting the terminal, verify both versions match:",
			"  bun --version",
			"  skc --version",
			"",
			"If 'skc' still loads the old runtime, make sure %USERPROFILE%\\.bun\\bin is",
			"first on PATH and remove any stale Bun installs shadowing it.",
		);
	} else {
		lines.push(
			"",
			"Upgrade Bun, then restart your terminal:",
			"  bun upgrade",
			"",
			"Then verify:",
			"  bun --version",
			"  skc --version",
		);
	}
	return `${lines.join("\n")}\n`;
}

// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Set the project directory. */
export function setProjectDir(dir: string): void {
	projectDir = standardizeMacOSPath(path.resolve(dir));
	process.chdir(projectDir);
}

/** Get the config directory name relative to home (e.g. ".skc" or PI_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return process.env.SKC_CONFIG_DIR ?? process.env.PI_CONFIG_DIR ?? CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".skc/agent" or PI_CONFIG_DIR + "/agent"). */
export function getConfigAgentDirName(): string {
	return `${getConfigDirName()}/agent`;
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches all sayknow-cli directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/skc/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/skc/.
	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;

	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(agentDirOverride?: string) {
		this.configRoot = path.join(os.homedir(), getConfigDirName());

		const defaultAgent = path.join(this.configRoot, "agent");
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		// XDG is a Linux convention. On other platforms, or for non-default
		// profiles, all categories resolve to the legacy paths.
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (value) {
					try {
						const joined = path.join(value, APP_NAME);
						if (fs.existsSync(joined)) {
							return joined;
						}
					} catch {}
				}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		// XDG flattens the agent/ prefix: ~/.skc/agent/sessions → $XDG_DATA_HOME/skc/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const cached = this.#rootCache.get(subdir);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(subdir, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const cached = this.#agentCache.get(subdir);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(subdir, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

let dirs = new DirResolver(process.env.SKC_CODING_AGENT_DIR);

// Anchor home for the resolver. Captured at module load to stay stable across
// test mocks of `os.homedir()`. `getPluginsDir(home)` compares against this so
// production callers (`home === RESOLVER_HOME`) hit the XDG-aware resolver while
// tests passing a temp HOME short-circuit to a deterministic path.
const RESOLVER_HOME = os.homedir();

// =============================================================================
// Root directories
// =============================================================================

/** Get the config root directory (~/.skc). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir: string): void {
	dirs = new DirResolver(dir);
	process.env.SKC_CODING_AGENT_DIR = dir;
}

/** Get the agent config directory (~/.skc/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.skc). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.skc/*)
// =============================================================================

/** Get the reports directory (~/.skc/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.skc/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.skc/logs/skc.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/**
 * Get the plugins directory (~/.skc/plugins or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter is for test
 * isolation: when it differs from `os.homedir()` it short-circuits the resolver
 * and returns `<home>/<configDir>/plugins` so tests with a temp HOME get a
 * deterministic path. Passing `os.homedir()` explicitly is identical to the
 * no-arg form — XDG semantics are preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (~/.skc/plugins/node_modules). */
export function getPluginsNodeModules(): string {
	return path.join(getPluginsDir(), "node_modules");
}

/** Plugin manifest (~/.skc/plugins/package.json). */
export function getPluginsPackageJson(): string {
	return path.join(getPluginsDir(), "package.json");
}

/** Plugin lock file (~/.skc/plugins/skc-plugins.lock.json). */
export function getPluginsLockfile(): string {
	return path.join(getPluginsDir(), "skc-plugins.lock.json");
}

/** Get the remote mount directory (~/.skc/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/** Get the agent-managed worktrees directory (~/.skc/wt). */
export function getWorktreesDir(): string {
	return dirs.rootSubdir("wt", "data");
}

/** Get the SSH control socket directory (~/.skc/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (~/.skc/remote-host). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.skc/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (~/.skc/agent/python-gateway; XDG default: $XDG_STATE_HOME/skc/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (~/.skc/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under `~/.skc/wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (~/.skc/wt/<segment>). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (~/.skc/gpu_cache.json). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the GitHub view cache database path (~/.skc/cache/github-cache.db).
 * Honors the `SKC_GITHUB_CACHE_DB` env var when set so tests can isolate the
 * cache file without touching the rest of the config root.
 */
export function getGithubCacheDbPath(): string {
	const override = process.env.SKC_GITHUB_CACHE_DB;
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}

/** Get the natives directory (~/.skc/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the stats database path (~/.skc/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (~/.skc/autoresearch). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (~/.skc/autoresearch/<encoded-project>). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (~/.skc/autoresearch/<encoded-project>.db). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

/** Get the per-run artifact directory (~/.skc/autoresearch/<encoded-project>/runs/<runId>). */
export function getAutoresearchRunDir(encodedProject: string, runId: number): string {
	return path.join(getAutoresearchProjectDir(encodedProject), "runs", String(runId).padStart(4, "0"));
}

// =============================================================================
// Agent subdirectories (~/.skc/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the sessions directory (~/.skc/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (~/.skc/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (~/.skc/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.skc/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.skc/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.skc/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.skc/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.skc/agent/memories). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (~/.skc/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (~/.skc/agent/skc-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "skc-crash.log", "state");
}

/** Get the debug log path (~/.skc/agent/skc-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.skc/*)
// =============================================================================

/** Get the project-level Python modules directory (.skc/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.skc/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.skc/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}
