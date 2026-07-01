import type { ResolvedTmuxBinary } from "./psmux-detect";
import { resolveSkcTmuxBinary } from "./psmux-detect";

export const SKC_DEFAULT_TMUX_SESSION = "sayknow_cli";
export const SKC_TMUX_SESSION_PREFIX = `${SKC_DEFAULT_TMUX_SESSION}_`;
export const SKC_TMUX_COMMAND_ENV = "SKC_TMUX_COMMAND";
export const SKC_TMUX_PROFILE_ENV = "SKC_TMUX_PROFILE";
export const SKC_TMUX_MOUSE_ENV = "SKC_MOUSE";
export const SKC_TMUX_PROFILE_OPTION = "@skc-profile";
export const SKC_TMUX_PROFILE_VALUE = "1";
export const SKC_TMUX_BRANCH_OPTION = "@skc-branch";
export const SKC_TMUX_BRANCH_SLUG_OPTION = "@skc-branch-slug";
export const SKC_TMUX_PROJECT_OPTION = "@skc-project";
export const SKC_TMUX_SESSION_ID_OPTION = "@skc-session-id";
export const SKC_TMUX_SESSION_STATE_FILE_OPTION = "@skc-session-state-file";
export const SKC_TMUX_VERSION_OPTION = "@skc-version";
export const SKC_PSMUX_PROFILE_FORCE_ENV = "SKC_PSMUX_PROFILE_FORCE";

export interface SkcTmuxProfileCommand {
	description: string;
	args: string[];
}

export interface TmuxCommandResult {
	exitCode: number | null;
	stdout?: string;
	stderr?: string;
	signalCode?: string | null;
}

export type TmuxCommandRunner = (args: string[]) => TmuxCommandResult;

export function envDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * Resolve the tmux (or tmux-compatible multiplexer) command SKC should invoke.
 *
 * This is the shared entry point used by every SKC code path that needs to talk
 * to a multiplexer: `skc --tmux` planning, `skc session ...`, `skc team ...`,
 * the lifecycle controller, and the harness resident owner. Routing all of
 * them through the same resolver means a single `SKC_TMUX_COMMAND` override or
 * a single Windows psmux / pmux detection wins for the whole process — the
 * failure mode where `skc --tmux` creates a psmux-backed session and then
 * `skc session status` fails because it queries literal `tmux` is closed off.
 *
 * Explicit `SKC_TMUX_COMMAND` / `SKC_TEAM_TMUX_COMMAND` overrides are honored on
 * every platform. On native Windows without an override the resolver walks
 * `psmux`, then `pmux`, then `tmux` and uses the first binary present on PATH.
 * On POSIX the resolver returns `tmux` (the historical default) and only
 * falls through to the platform-aware walker if the caller opts in.
 */
export function resolveSkcTmuxCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return resolveSkcTmuxBinary({ env, platform }).command;
}

export type { PsmuxProbe, ResolvedTmuxBinary, ResolveSkcTmuxBinaryOptions } from "./psmux-detect";
export { clearPsmuxDetectionCache, detectPsmux, probePsmux, resolveSkcTmuxBinary } from "./psmux-detect";

/**
 * Build the exact-session target for tmux *option* commands
 * (`show-options` / `set-option`) and `display-message -t`.
 *
 * Session-scoped commands such as `kill-session` / `attach-session` resolve a
 * bare exact target (`=NAME`), but tmux 3.6a refuses to resolve a bare `=NAME`
 * for option/display commands. Appending the empty window separator (`=NAME:`)
 * keeps the exact-session match while giving tmux the window-qualified target
 * those commands require. See sayknow-cli#580.
 */
export function buildSkcTmuxExactOptionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveSkcTmuxBinary({ env: opts.env, platform: opts.platform });
	// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix for option
	// commands ("no server running on session '=NAME'"); bare `NAME` and
	// window-qualified `NAME:` both work. tmux 3.6a needs the
	// window-qualified `=NAME:` to resolve the session for option
	// commands (sayknow-cli#580).
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}:`;
}

/**
 * Build the exact-session target for tmux *session-scoped* commands such as
 * `attach-session` and `kill-session`. Native tmux accepts `=NAME` for an
 * exact session match, but Windows psmux 3.3.x rejects that target form for
 * session commands even though the bare `NAME` resolves. Keep native tmux on
 * exact targets and intentionally use the bare session name for psmux.
 */
export function buildSkcTmuxExactSessionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveSkcTmuxBinary({ env: opts.env, platform: opts.platform });
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}`;
}

export const SKC_TMUX_UNTAGGED_REASON = "skc_tmux_session_untagged";

export function buildSkcTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return SKC's ${SKC_TMUX_PROFILE_OPTION} ownership tag; ` +
		"SKC-managed sessions and `skc team` require a tmux provider that round-trips tmux user options. " +
		"For psmux on Windows, cwd/start-directory flags such as `-c` do not isolate the server namespace; psmux uses the tmux-compatible global `-L <namespace>` flag for that. " +
		"SKC_TMUX_COMMAND and SKC_TEAM_TMUX_COMMAND are binary overrides, not shell command lines, so `psmux -L name` is not a supported value. " +
		"Alternative multiplexers such as psmux on Windows do not reliably persist user options yet, so the Windows-native psmux path is not fully supported; " +
		"use real tmux for SKC-managed session and team flows."
	);
}

export function buildSkcTmuxUntaggedSessionError(sessionName: string, tmuxCommand: string): string {
	return `${SKC_TMUX_UNTAGGED_REASON}:${sessionName} — ${buildSkcTmuxUntaggedSessionHint(tmuxCommand)}`;
}

export function sanitizeTmuxToken(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "default"
	);
}

export function buildSkcTmuxSessionSlug(value: string): string {
	return sanitizeTmuxToken(value);
}

function randomTmuxSessionSuffix(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function buildSkcTmuxSessionName(
	env: NodeJS.ProcessEnv = process.env,
	context: { branch?: string | null; now?: number; id?: string } = {},
): string {
	const explicit = env.SKC_TMUX_SESSION?.trim();
	if (explicit) return explicit;
	const timestamp = (context.now ?? Date.now()).toString(36);
	const id = context.id ?? randomTmuxSessionSuffix();
	const branchSlug = context.branch ? `${buildSkcTmuxSessionSlug(context.branch)}_` : "";
	return `${SKC_TMUX_SESSION_PREFIX}${branchSlug}${timestamp}_${id}`;
}

export function buildSkcTmuxRequiredProfileCommands(
	target: string,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
): SkcTmuxProfileCommand[] {
	const commands: SkcTmuxProfileCommand[] = [
		{
			description: "mark SKC tmux ownership",
			args: ["set-option", "-t", target, SKC_TMUX_PROFILE_OPTION, SKC_TMUX_PROFILE_VALUE],
		},
	];
	if (metadata.branch)
		commands.push({
			description: "record SKC branch identity",
			args: ["set-option", "-t", target, SKC_TMUX_BRANCH_OPTION, metadata.branch],
		});
	if (metadata.branchSlug)
		commands.push({
			description: "record SKC branch slug",
			args: ["set-option", "-t", target, SKC_TMUX_BRANCH_SLUG_OPTION, metadata.branchSlug],
		});
	if (metadata.project)
		commands.push({
			description: "record SKC project identity",
			args: ["set-option", "-t", target, SKC_TMUX_PROJECT_OPTION, metadata.project],
		});
	if (metadata.sessionId)
		commands.push({
			description: "record SKC session identity",
			args: ["set-option", "-t", target, SKC_TMUX_SESSION_ID_OPTION, metadata.sessionId],
		});
	if (metadata.sessionStateFile)
		commands.push({
			description: "record SKC session state marker",
			args: ["set-option", "-t", target, SKC_TMUX_SESSION_STATE_FILE_OPTION, metadata.sessionStateFile],
		});
	if (metadata.version)
		commands.push({
			description: "record SKC version identity",
			args: ["set-option", "-t", target, SKC_TMUX_VERSION_OPTION, metadata.version],
		});
	return commands;
}

/**
 * Keys whose set-option / set-window-option round-trip is unreliable on psmux
 * 3.3.0. psmux does not support the tmux `set-window-option` command at all
 * (it reports "unknown command: set-window-option") and silently drops several
 * `set-option` keys. The list lives here so every code path that tags a tmux
 * session (skc --tmux planning, skc session create, skc team bootstrap)
 * applies the same filter.
 */
const PSMUX_UNSUPPORTED_PROFILE_KEYS = new Set(["mouse", "set-clipboard", "mode-style"]);

export function buildSkcTmuxProfileCommands(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
	opts: { platform?: NodeJS.Platform; tmuxCommand?: string } = {},
): SkcTmuxProfileCommand[] {
	const commands = buildSkcTmuxRequiredProfileCommands(target, metadata);
	if (envDisabled(env[SKC_TMUX_PROFILE_ENV])) return commands;
	commands.push(
		{ description: "enable tmux clipboard integration", args: ["set-option", "-t", target, "set-clipboard", "on"] },
		{
			description: "make copy-mode selection readable",
			args: ["set-window-option", "-t", target, "mode-style", "fg=colour231,bg=colour60"],
		},
	);
	if (!envDisabled(env[SKC_TMUX_MOUSE_ENV]))
		commands.unshift({
			description: "enable tmux mouse scrolling",
			args: ["set-option", "-t", target, "mouse", "on"],
		});
	// psmux does not implement set-window-option and historically drops
	// mouse / set-clipboard / mode-style. Filter the UX profile commands
	// centrally so every code path that tags a session (skc --tmux planning,
	// skc session create, skc team bootstrap) drops the same set. The
	// SKC_PSMUX_PROFILE_FORCE override lets the operator opt back in when
	// running on a psmux build that has caught up. The ownership-tag
	// round-trip (set-option @skc-*) is never filtered, since skc session /
	// skc team rely on it.
	// The filter is opt-in: callers that explicitly pass `opts.tmuxCommand`
	// name a psmux-class multiplexer (psmux / pmux) when they want the UX
	// profile filtered. Auto-detect on Windows hosts where psmux happens
	// to be on PATH would silently change the test output for every caller
	// that does not pin the multiplexer, so we require the caller to opt
	// in by naming the multiplexer. SKC_PSMUX_PROFILE_FORCE re-enables
	// the UX profile commands when a psmux build catches up.
	const tmuxName = (opts.tmuxCommand ?? "").toLowerCase();
	const isPsmuxClass =
		tmuxName === "psmux" ||
		tmuxName === "pmux" ||
		tmuxName.endsWith("/psmux") ||
		tmuxName.endsWith("/pmux") ||
		tmuxName.endsWith("\\psmux") ||
		tmuxName.endsWith("\\pmux");
	const dropUx = isPsmuxClass && !envDisabled(env[SKC_PSMUX_PROFILE_FORCE_ENV]);
	if (dropUx) {
		return commands.filter(command => {
			const flag = command.args[0];
			const key = command.args[command.args.length - 2];
			return !(
				PSMUX_UNSUPPORTED_PROFILE_KEYS.has(String(key)) &&
				(flag === "set-option" || flag === "set-window-option")
			);
		});
	}
	return commands;
}

export function normalizeTmuxCreatedAt(raw: string): string {
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return raw;
	return new Date(seconds * 1000).toISOString();
}
