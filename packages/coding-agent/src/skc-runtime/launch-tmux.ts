import { Buffer } from "node:buffer";
import * as path from "node:path";
import { VERSION } from "@sayknow-cli/utils/dirs";
import { safeStderrWrite } from "@sayknow-cli/utils/safe-stderr";
import type { Args } from "../cli/args";
import { tmuxRuntimeSessionPath } from "./session-layout";
import { SKC_COORDINATOR_SESSION_ID_ENV, SKC_COORDINATOR_SESSION_STATE_FILE_ENV } from "./session-state-sidecar";
import {
	buildSkcTmuxExactSessionTarget,
	buildSkcTmuxProfileCommands,
	buildSkcTmuxSessionName,
	buildSkcTmuxSessionSlug,
	resolveSkcTmuxBinary,
	resolveSkcTmuxCommand,
	SKC_DEFAULT_TMUX_SESSION,
	SKC_TMUX_COMMAND_ENV,
	SKC_TMUX_MOUSE_ENV,
	SKC_TMUX_PROFILE_ENV,
	SKC_TMUX_SESSION_PREFIX,
	type SkcTmuxProfileCommand,
} from "./tmux-common";
import {
	abandonIdentityCreate,
	advanceIdentityCreatePhase,
	type IdentityCreateReservation,
	releaseIdentityCreate,
	reserveIdentityCreate,
} from "./tmux-owner-isolation";
import { findSkcTmuxSessionByName, findSkcTmuxSessionByScope, type SkcTmuxSessionStatus } from "./tmux-sessions";

export {
	buildSkcTmuxExactSessionTarget,
	buildSkcTmuxProfileCommands,
	SKC_DEFAULT_TMUX_SESSION,
	SKC_TMUX_COMMAND_ENV,
	SKC_TMUX_MOUSE_ENV,
	SKC_TMUX_PROFILE_ENV,
	SKC_TMUX_SESSION_PREFIX,
};

export const SKC_TMUX_LAUNCHED_ENV = "SKC_TMUX_LAUNCHED";
export const SKC_LAUNCH_POLICY_ENV = "SKC_LAUNCH_POLICY";
export const SKC_TMUX_WINDOW_LABEL_MAX_WIDTH = 48;
export const SKC_PSMUX_PROFILE_FORCE_ENV = "SKC_PSMUX_PROFILE_FORCE";

type LaunchPolicy = "direct" | "tmux";

interface TtyState {
	stdin: boolean;
	stdout: boolean;
}

export interface TmuxLaunchContext {
	parsed: Args;
	rawArgs: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	argv?: string[];
	execPath?: string;
	platform?: NodeJS.Platform;
	tty?: TtyState;
	spawnSync?: TmuxSpawnSync;
	tmuxAvailable?: boolean;
	worktreeBranch?: string | null;
	currentBranch?: string | null;
	existingBranchSessionName?: string | null;
	project?: string | null;
	diagnosticWriter?: (message: string) => void;
}

export interface TmuxSpawnResult {
	exitCode: number | null;
	signalCode?: string | null;
	stderr?: string;
	/** Populated only when the caller asked for `stdout: "pipe"`. */
	stdout?: string;
}

export type TmuxSpawnSync = (command: string, args: string[], options: TmuxSpawnOptions) => TmuxSpawnResult;

export interface TmuxSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdin: "inherit";
	stdout: "inherit" | "pipe";
	stderr: "inherit" | "pipe";
}

export interface TmuxLaunchPlan {
	tmuxCommand: string;
	sessionName: string;
	cwd: string;
	innerCommand: string;
	newSessionArgs: string[];
	branch?: string | null;
	attachSessionName?: string;
	project?: string | null;
	sessionId?: string | null;
	sessionStateFile?: string | null;
	/**
	 * Capability of the RESOLVED provider, not a platform guess. psmux has no
	 * immutable native session identity, so it stays outside the native-proof
	 * create fence and keeps its existing spawn/profile/attach behavior.
	 */
	isPsmux: boolean;
}

function explicitTmuxSessionName(env: NodeJS.ProcessEnv): string | undefined {
	return env.SKC_TMUX_SESSION?.trim() || undefined;
}
function hasCurrentSkcVersion(session: SkcTmuxSessionStatus | undefined): boolean {
	return session?.version === VERSION;
}

function allowsExistingTmuxAttach(parsed: Args, env: NodeJS.ProcessEnv): boolean {
	return Boolean(parsed.continue || parsed.resume || explicitTmuxSessionName(env));
}

function findExistingSessionForLaunch(context: {
	env: NodeJS.ProcessEnv;
	project: string;
	branch?: string | null;
}): string | undefined {
	const explicit = explicitTmuxSessionName(context.env);
	if (explicit) return findSkcTmuxSessionByName(explicit, context.env)?.name;
	const scoped = findSkcTmuxSessionByScope(context.project, context.branch, context.env);
	return hasCurrentSkcVersion(scoped) ? scoped?.name : undefined;
}

export interface SkcTmuxProfileResult {
	skipped: boolean;
	commands: SkcTmuxProfileCommand[];
	failures: Array<{ command: SkcTmuxProfileCommand; stderr?: string }>;
}

export interface SkcTmuxProfileContext {
	tmuxCommand: string;
	target: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	spawnSync?: TmuxSpawnSync;
	branch?: string | null;
	branchSlug?: string | null;
	project?: string | null;
	sessionId?: string | null;
	sessionStateFile?: string | null;
	version?: string | null;
}

interface CommandResolutionContext {
	cwd: string;
	argv: string[];
	execPath: string;
	extraEnv?: Record<string, string>;
	platform?: NodeJS.Platform;
}

function parseLaunchPolicy(env: NodeJS.ProcessEnv): LaunchPolicy {
	const raw = env[SKC_LAUNCH_POLICY_ENV]?.trim().toLowerCase();
	if (raw === "direct" || raw === "tmux") return raw;
	if (env.SKC_NO_TMUX === "1" || env.SKC_NO_TMUX === "true") return "direct";
	return "tmux";
}

function isInteractiveRootLaunch(parsed: Args, tty: TtyState): boolean {
	return (
		tty.stdin &&
		tty.stdout &&
		!parsed.help &&
		!parsed.version &&
		!parsed.print &&
		parsed.mode === undefined &&
		parsed.export === undefined &&
		parsed.listModels === undefined
	);
}

function isBunVirtualPath(value: string | undefined): boolean {
	return value?.startsWith("/$bunfs/") === true;
}

function formatTmuxLaunchDiagnostic(stage: string, stderr?: string): string {
	const detail = stderr?.trim();
	const suffix = detail ? ` ${detail.slice(0, 240)}` : "";
	return `skc --tmux failed after creating tmux session: ${stage}.${suffix}\n`;
}

function formatTmuxUnavailableDiagnostic(platform: NodeJS.Platform, tmuxCommand: string): string {
	if (platform === "win32") {
		return (
			`skc --tmux requested but no tmux executable was found; starting without a tmux-backed session. ` +
			`SKC searched for psmux, pmux, and tmux on PATH (got \`${tmuxCommand}\`). ` +
			"Install psmux (https://github.com/psmux/psmux) for native Windows tmux support, or use WSL with real tmux. " +
			"You can also point SKC at a specific binary via SKC_TMUX_COMMAND.\n"
		);
	}
	return `skc --tmux requested but no ${tmuxCommand} executable was found; starting without a tmux-backed session.\n`;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildEnvAssignments(values: Record<string, string> | undefined): string {
	const entries = Object.entries(values ?? {});
	return entries.length === 0 ? "" : ` ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}`;
}
function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
function stripRootTmuxFlag(rawArgs: string[]): string[] {
	return rawArgs.filter(arg => arg !== "--tmux");
}

function buildWindowsPowerShellInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	const command = resolveCurrentSkcCommand(context);
	const envLines = Object.entries({ [SKC_TMUX_LAUNCHED_ENV]: "1", ...(context.extraEnv ?? {}) }).map(
		([key, value]) => `$env:${key} = ${powershellQuote(value)}`,
	);
	// The inner `&` invocation must wrap the resolved skc command in a
	// script-block so the trailing PowerShell exec-policy flags from the
	// outer invocation are not forwarded into the bun / node / .bat
	// binary the skc command resolves to. Without the wrapping, the flags
	// reach the runtime binary and cause an immediate failure that closes
	// the psmux pane before the skc --tmux attach can land.
	const resolvedCommand = command.map(powershellQuote).join(" ");
	const innerArgs = stripRootTmuxFlag(rawArgs).map(powershellQuote).join(" ");
	const invocation = `& { ${resolvedCommand} ${innerArgs} }`;
	const exitLine = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 }";
	const script = [...envLines, invocation, exitLine].join("\n");
	// PowerShell -EncodedCommand requires a UTF-16LE BOM (0xFF 0xFE) at the
	// start of the decoded buffer; without it pwsh may misinterpret the
	// leading bytes and reject the script with a parse error, which would
	// kill the psmux pane before the skc --tmux attach could land.
	const bom = Buffer.from([0xff, 0xfe]);
	const body = Buffer.from(script, "utf16le");
	const encodedCommand = Buffer.concat([bom, body]).toString("base64");
	return `pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
}

export function applySkcTmuxProfile(context: SkcTmuxProfileContext): SkcTmuxProfileResult {
	const env = context.env ?? process.env;
	const branchSlug = context.branch ? buildSkcTmuxSessionSlug(context.branch) : (context.branchSlug ?? null);
	// The psmux UX filter (mouse / set-clipboard / mode-style /
	// set-window-option) now lives in buildSkcTmuxProfileCommands so every
	// caller — skc --tmux planning, skc session create, skc team bootstrap —
	// applies the same drop set when the active multiplexer is psmux. We pass
	// the resolved tmuxCommand through the new opts seam so the filter
	// engages for this exact command, not whatever the resolver returns at
	// profile-build time.
	const commands = buildSkcTmuxProfileCommands(
		context.target,
		env,
		{
			branch: context.branch ?? null,
			branchSlug,
			project: context.project ?? null,
			sessionId: context.sessionId ?? env[SKC_COORDINATOR_SESSION_ID_ENV] ?? null,
			sessionStateFile: context.sessionStateFile ?? env[SKC_COORDINATOR_SESSION_STATE_FILE_ENV] ?? null,
			version: context.version ?? null,
		},
		{ tmuxCommand: context.tmuxCommand },
	);
	if (commands.length === 0) return { skipped: true, commands: [], failures: [] };
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	const cwd = context.cwd ?? process.cwd();
	const options: TmuxSpawnOptions = { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" };
	const failures: SkcTmuxProfileResult["failures"] = [];
	for (const command of commands) {
		const result = spawnSync(context.tmuxCommand, command.args, options);
		if (result.exitCode !== 0) failures.push({ command, stderr: result.stderr });
	}
	return { skipped: false, commands, failures };
}

function resolveCurrentSkcCommand(context: CommandResolutionContext): string[] {
	const entrypoint = context.argv[1];
	if (!entrypoint) return ["skc"];
	if (isBunVirtualPath(entrypoint)) {
		return isBunVirtualPath(context.execPath) ? ["skc"] : [context.execPath];
	}
	const pathModule = pathModuleForPlatform(context.platform);
	const resolvedEntrypoint = pathModule.isAbsolute(entrypoint)
		? entrypoint
		: pathModule.resolve(context.cwd, entrypoint);
	if (entrypoint.endsWith(".ts") || entrypoint.endsWith(".js") || entrypoint.endsWith(".mjs")) {
		return [context.execPath, resolvedEntrypoint];
	}
	return [resolvedEntrypoint];
}
function isWindowsPlatform(platform: NodeJS.Platform | undefined): boolean {
	return platform === "win32";
}
function pathModuleForPlatform(platform: NodeJS.Platform | undefined): typeof path.win32 | typeof path {
	return isWindowsPlatform(platform) ? path.win32 : path;
}

function buildInnerCommand(context: CommandResolutionContext, rawArgs: string[]): string {
	if (isWindowsPlatform(context.platform)) return buildWindowsPowerShellInnerCommand(context, rawArgs);
	const command = resolveCurrentSkcCommand(context);
	const quoted = [...command, ...stripRootTmuxFlag(rawArgs)].map(shellQuote).join(" ");
	return `exec env ${SKC_TMUX_LAUNCHED_ENV}=1${buildEnvAssignments(context.extraEnv)} ${quoted}`;
}

function visibleWidth(value: string): number {
	return Bun.stringWidth(value);
}

function truncateVisible(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";

	let result = "";
	for (const char of value) {
		if (visibleWidth(`${result}${char}…`) > maxWidth) break;
		result += char;
	}

	return `${result}…`;
}

function truncateVisibleTail(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth === 1) return "…";

	let result = "";
	for (const char of Array.from(value).reverse()) {
		if (visibleWidth(`…${char}${result}`) > maxWidth) break;
		result = `${char}${result}`;
	}

	return `…${result}`;
}

const SKC_TMUX_WINDOW_BRANCH_SEPARATOR = "-";

function sanitizeTmuxWindowTitleSegment(value: string): string {
	return value.replace(/:+/g, "-");
}

function sanitizeTmuxWindowProjectName(project: string): string {
	const trimmed = project.trim();
	if (!trimmed || /^\.+$/.test(trimmed)) return "skc";
	if (trimmed.startsWith(".")) return sanitizeTmuxWindowTitleSegment(`dot-${trimmed.replace(/^\.+/, "")}`);
	return sanitizeTmuxWindowTitleSegment(trimmed);
}

export function buildSkcTmuxWindowTitle(cwd: string, branch: string | null | undefined): string {
	const project = sanitizeTmuxWindowProjectName(path.basename(path.resolve(cwd)) || "skc");
	const trimmedBranch = sanitizeTmuxWindowTitleSegment(branch?.trim() ?? "");
	if (!trimmedBranch) return truncateVisible(project, SKC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	const separatorWidth = visibleWidth(SKC_TMUX_WINDOW_BRANCH_SEPARATOR);
	const projectWidth = visibleWidth(project);
	const fullTitle = `${project}${SKC_TMUX_WINDOW_BRANCH_SEPARATOR}${trimmedBranch}`;
	if (visibleWidth(fullTitle) <= SKC_TMUX_WINDOW_LABEL_MAX_WIDTH) return fullTitle;

	const remainingBranchWidth = SKC_TMUX_WINDOW_LABEL_MAX_WIDTH - projectWidth - separatorWidth;
	if (remainingBranchWidth <= 0) return truncateVisible(project, SKC_TMUX_WINDOW_LABEL_MAX_WIDTH);

	return `${project}${SKC_TMUX_WINDOW_BRANCH_SEPARATOR}${truncateVisibleTail(trimmedBranch, remainingBranchWidth)}`;
}

function buildTmuxRenameWindowArgs(title: string, target?: string): string[] {
	return target ? ["rename-window", "-t", target, "--", title] : ["rename-window", "--", title];
}

function renameTmuxWindow(
	tmuxCommand: string,
	title: string,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	target?: string,
): void {
	spawnSync(tmuxCommand, buildTmuxRenameWindowArgs(title, target), options);
}

function renameExistingTmuxWindowIfNeeded(context: TmuxLaunchContext): void {
	const env = context.env ?? process.env;
	if (!env.TMUX || env[SKC_TMUX_LAUNCHED_ENV] === "1") return;
	if (parseLaunchPolicy(env) === "direct") return;

	// Note: Windows is intentionally allowed here. Psmux supports
	// `rename-window` and we want the leader window to inherit the
	// sanitized project-branch title even on native Windows, where
	// skc --tmux runs through PowerShell to a psmux backend.

	const tty = context.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
	if (!isInteractiveRootLaunch(context.parsed, tty)) return;

	const tmuxCommand = resolveSkcTmuxCommand(env);
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) return;

	const cwd = context.cwd ?? process.cwd();
	const branch = context.worktreeBranch ?? context.currentBranch ?? readCurrentBranch(cwd);
	const title = buildSkcTmuxWindowTitle(context.project ?? cwd, branch);
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	renameTmuxWindow(tmuxCommand, title, spawnSync, {
		cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
}

function readCurrentBranch(cwd: string): string | null {
	try {
		const result = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		if (result.exitCode !== 0) return null;
		const branch = result.stdout.toString().trim();
		return branch || null;
	} catch {
		return null;
	}
}

/**
 * Immutable identity of a session this process created, used so cleanup can
 * never target a different session that merely reuses the name.
 */
interface CreatedSessionIdentity {
	nativeSessionId: string;
	serverPid: string;
	/** Session birth time: distinguishes a reused `$id` on a restarted server. */
	sessionCreated: string;
}

/**
 * Reads `#{session_id}` and the server `#{pid}` for the session just created.
 * Returns null when the provider cannot supply them, in which case cleanup falls
 * back to the pre-existing name-based path.
 */
function captureCreatedSessionIdentity(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
): CreatedSessionIdentity | null {
	const probed = spawnSync(
		plan.tmuxCommand,
		[
			"display-message",
			"-p",
			"-t",
			buildSkcTmuxExactSessionTarget(plan.sessionName, { env: options.env }),
			"#{session_id}\t#{pid}\t#{session_created}",
		],
		{ ...options, stdout: "pipe" },
	);
	if (probed.exitCode !== 0 || typeof probed.stdout !== "string") return null;
	const [nativeSessionId, serverPid, sessionCreated] = probed.stdout.trim().split("\t");
	if (!nativeSessionId?.startsWith("$") || !serverPid || !sessionCreated) return null;
	return { nativeSessionId, serverPid, sessionCreated };
}

/**
 * Returns false when the created session was NOT provably removed, so the caller
 * can keep the reservation as evidence for authority-first recovery.
 */
function cleanupCreatedTmuxSession(
	plan: TmuxLaunchPlan,
	spawnSync: TmuxSpawnSync,
	options: TmuxSpawnOptions,
	identity?: CreatedSessionIdentity | null,
): boolean {
	if (plan.isPsmux) {
		// Capability carveout: psmux exposes no immutable session identity, so the
		// pre-existing name-based cleanup is all that is available there.
		const killed = spawnSync(
			plan.tmuxCommand,
			["kill-session", "-t", buildSkcTmuxExactSessionTarget(plan.sessionName, { env: options.env })],
			options,
		);
		return killed.exitCode === 0;
	}
	// Fail closed: without the immutable identity we cannot prove what we would be
	// killing, and a session NAME may belong to somebody else by now. Leaking a
	// session is recoverable; killing an unrelated one is not.
	if (!identity) return false;
	// One tmux invocation proves AND kills, so no other process can swap the
	// target between the check and the kill. The predicate pins the server
	// incarnation, the exact session id, and that session's birth time.
	const predicate = [
		`#{&&:#{==:#{pid},${identity.serverPid}}`,
		`#{&&:#{==:#{session_id},${identity.nativeSessionId}}`,
		`#{==:#{session_created},${identity.sessionCreated}}}}`,
	].join(",");
	spawnSync(
		plan.tmuxCommand,
		["if-shell", "-t", identity.nativeSessionId, "-F", predicate, `kill-session -t ${identity.nativeSessionId}`],
		options,
	);
	// `if-shell` exits 0 even when the predicate is false and nothing ran, so its
	// exit code is not proof. Ask whether that exact session is still there.
	const survivor = spawnSync(plan.tmuxCommand, ["has-session", "-t", identity.nativeSessionId], {
		...options,
		stdout: "pipe",
		stderr: "pipe",
	});
	// A signalled or otherwise unfinished probe answers nothing. Treating that as
	// removal would delete the only evidence that a child may survive, so an
	// indeterminate result fails closed.
	if (typeof survivor.exitCode !== "number") return false;
	// Zero means the session is still there.
	if (survivor.exitCode === 0) return false;
	// Non-zero is ambiguous on its own: tmux exits non-zero both for a session it
	// cannot find and for an operational failure such as a refused socket. Only an
	// explicit absence — including the whole server being gone — proves our child
	// is no longer on a server we own. Anything else fails closed.
	const diagnostic = (survivor.stderr ?? "").toLowerCase();
	return (
		diagnostic.includes("can't find session") ||
		diagnostic.includes("cannot find session") ||
		diagnostic.includes("session not found") ||
		diagnostic.includes("no server running") ||
		diagnostic.includes("no such file or directory")
	);
}
function isTmuxAttachDisconnectError(result: TmuxSpawnResult): boolean {
	if (result.signalCode === "SIGHUP") return true;
	const stderr = result.stderr?.toLowerCase() ?? "";
	return stderr.includes("eio") || stderr.includes("input/output error");
}

export function buildDefaultTmuxLaunchPlan(context: TmuxLaunchContext): TmuxLaunchPlan | undefined {
	const env = context.env ?? process.env;
	const policy = parseLaunchPolicy(env);
	if (!context.parsed.tmux || policy === "direct") return undefined;
	if (env.TMUX || env[SKC_TMUX_LAUNCHED_ENV] === "1") return undefined;
	const platform = context.platform ?? process.platform;
	const tty = context.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
	if (policy === "tmux" && !isInteractiveRootLaunch(context.parsed, tty)) return undefined;

	const cwd = context.cwd ?? process.cwd();
	const branch = context.worktreeBranch ?? context.currentBranch ?? readCurrentBranch(cwd);
	const project = context.project ?? cwd;
	const sessionName = buildSkcTmuxSessionName(env, { branch });
	// Pick the most appropriate tmux binary for this platform. On native Windows
	// the resolver walks psmux / pmux / tmux and uses the first one present on
	// PATH, so the default `skc --tmux` flow lands on a real multiplexer even
	// without an explicit SKC_TMUX_COMMAND override.
	const resolvedBinary = resolveSkcTmuxBinary({ platform, env });
	const tmuxCommand = resolvedBinary.command;
	const sessionId = env[SKC_COORDINATOR_SESSION_ID_ENV]?.trim() || sessionName;
	// The session ROOT is keyed by the active SKC session (SKC_SESSION_ID), NOT the
	// coordinator/tmux identity. Fall back to the coordinator id only for standalone
	// tmux launches with no SKC session context.
	const skcSessionId = env.SKC_SESSION_ID?.trim() || sessionId;
	const sessionStateFile =
		env[SKC_COORDINATOR_SESSION_STATE_FILE_ENV]?.trim() ||
		tmuxRuntimeSessionPath(cwd, skcSessionId, buildSkcTmuxSessionSlug(sessionName));
	const tmuxAvailable = context.tmuxAvailable ?? Bun.which(tmuxCommand) !== null;
	if (!tmuxAvailable) {
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxUnavailableDiagnostic(platform, tmuxCommand));
		return undefined;
	}
	const existingSessionName = allowsExistingTmuxAttach(context.parsed, env)
		? "existingBranchSessionName" in context
			? (context.existingBranchSessionName ?? undefined)
			: findExistingSessionForLaunch({
					env,
					project,
					branch,
				})
		: undefined;
	const innerCommand = buildInnerCommand(
		{
			cwd,
			argv: context.argv ?? process.argv,
			execPath: context.execPath ?? process.execPath,
			extraEnv: {
				[SKC_COORDINATOR_SESSION_ID_ENV]: sessionId,
				[SKC_COORDINATOR_SESSION_STATE_FILE_ENV]: sessionStateFile,
			},
			platform,
		},
		context.rawArgs,
	);
	return {
		tmuxCommand,
		sessionName,
		cwd,
		innerCommand,
		newSessionArgs: ["new-session", "-d", "-s", sessionName, "-c", cwd, innerCommand],
		branch,
		project,
		sessionId,
		sessionStateFile,
		attachSessionName: existingSessionName,
		isPsmux: resolvedBinary.isPsmux,
	};
}

function defaultSpawnSync(command: string, args: string[], options: TmuxSpawnOptions): TmuxSpawnResult {
	const result = Bun.spawnSync({
		cmd: [command, ...args],
		cwd: options.cwd,
		env: options.env,
		stdin: options.stdin,
		stdout: options.stdout,
		stderr: options.stderr,
	});
	return {
		exitCode: result.exitCode,
		signalCode: result.signalCode,
		...(options.stdout === "pipe" ? { stdout: result.stdout?.toString() } : {}),
		...(options.stderr === "pipe" ? { stderr: result.stderr?.toString() } : {}),
	};
}

export function launchDefaultTmuxIfNeeded(context: TmuxLaunchContext): boolean {
	renameExistingTmuxWindowIfNeeded(context);

	const plan = buildDefaultTmuxLaunchPlan(context);
	if (!plan) return false;
	const env = context.env ?? process.env;
	const spawnSync = context.spawnSync ?? defaultSpawnSync;
	const options: TmuxSpawnOptions = {
		cwd: plan.cwd,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};

	if (plan.attachSessionName) {
		const attached = spawnSync(
			plan.tmuxCommand,
			["attach-session", "-t", buildSkcTmuxExactSessionTarget(plan.attachSessionName, { env })],
			options,
		);
		if (attached.exitCode === 0) return true;
	}

	// Shared identity create fence for the CREATED branch only. The attach
	// fallback above is not a creator and stays unfenced.
	//
	// Capability, not platform: psmux exposes no immutable native session
	// identity, so it cannot participate in the native-proof fence and keeps its
	// existing behavior. That carveout is safe because restore already ends in
	// `unsupported_owner_proof` before it can create on psmux, so no restore
	// child can race this producer.
	const fenceIdentity =
		plan.isPsmux || !plan.sessionId || !plan.sessionStateFile
			? null
			: {
					stateDir: path.dirname(plan.sessionStateFile),
					sessionId: plan.sessionId,
					stateFile: plan.sessionStateFile,
				};
	let reservation: IdentityCreateReservation | null = null;
	let cleanupUncertain = false;
	if (fenceIdentity) {
		const reserved = reserveIdentityCreate(fenceIdentity);
		if (!reserved.ok) {
			// A PROVEN competing owner blocks the launch: perform no tmux mutation
			// (no spawn, no attach, no delete). Falling through to a direct
			// in-process launch is refused too, because it would put a second
			// writer on the same coordinator transcript.
			// Fail closed for every non-ok result. The fence database lives under
			// SKC's own config root, so an unreachable fence is not a routine
			// environment difference: it means the one-create guarantee cannot be
			// honored, and launching anyway risks a second writer on this identity.
			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("identity create fence", `${reserved.code}: ${reserved.diagnostic}`),
			);
			return true;
		}
		reservation = reserved.reservation;
	}
	try {
		// Record the attempt name BEFORE the first spawn-capable call, exactly like
		// the other producers. Without it a crash between `new-session` and the
		// release leaves the row at `reserved`, which a successor reclaims WITHOUT a
		// census — and that is how a second owner reaches one transcript.
		if (reservation) {
			reservation =
				advanceIdentityCreatePhase(reservation, "helper_invoked", { attemptSessionName: plan.sessionName }) ??
				(() => {
					throw new Error("skc_tmux_identity_create_fence_lost");
				})();
		}
		const created = spawnSync(plan.tmuxCommand, plan.newSessionArgs, options);
		// Capture the immutable native identity while we still know the session we
		// just made is the one behind this name. psmux cannot supply it, which is
		// exactly why it stays outside the native-proof guarantee.
		const createdIdentity =
			created.exitCode === 0 && !plan.isPsmux ? captureCreatedSessionIdentity(plan, spawnSync, options) : null;
		if (created.exitCode === 0) {
			renameTmuxWindow(
				plan.tmuxCommand,
				buildSkcTmuxWindowTitle(plan.project ?? plan.cwd, plan.branch),
				spawnSync,
				options,
				buildSkcTmuxExactSessionTarget(plan.sessionName, { env }),
			);

			const profile = applySkcTmuxProfile({
				tmuxCommand: plan.tmuxCommand,
				target: plan.sessionName,
				cwd: plan.cwd,
				env,
				spawnSync,
				branch: plan.branch,
				project: plan.project,
				sessionId: plan.sessionId ?? null,
				sessionStateFile: plan.sessionStateFile ?? null,
				version: VERSION,
			});
			const ownershipFailure = profile.failures.find(item => item.command.args.includes("@skc-profile"));
			if (ownershipFailure) {
				if (!cleanupCreatedTmuxSession(plan, spawnSync, options, createdIdentity)) cleanupUncertain = true;
				(context.diagnosticWriter ?? safeStderrWrite)(
					formatTmuxLaunchDiagnostic("profile tagging failed", ownershipFailure.stderr),
				);
				return true;
			}
		}
		if (created.exitCode !== 0) return false;
		const attached = spawnSync(
			plan.tmuxCommand,
			["attach-session", "-t", buildSkcTmuxExactSessionTarget(plan.sessionName, { env })],
			options,
		);
		if (attached.exitCode === 0) return true;
		if (isTmuxAttachDisconnectError(attached)) {
			(context.diagnosticWriter ?? safeStderrWrite)(
				formatTmuxLaunchDiagnostic("attach disconnected", attached.stderr),
			);
			return true;
		}
		if (!cleanupCreatedTmuxSession(plan, spawnSync, options, createdIdentity)) cleanupUncertain = true;
		(context.diagnosticWriter ?? safeStderrWrite)(formatTmuxLaunchDiagnostic("attach failed", attached.stderr));
		return true;
	} finally {
		if (reservation) {
			// An unproven cleanup may have left a child; its row is the only evidence
			// a successor gets, so end the attempt without deleting it.
			if (cleanupUncertain) abandonIdentityCreate(reservation);
			else releaseIdentityCreate(reservation);
		}
	}
}
