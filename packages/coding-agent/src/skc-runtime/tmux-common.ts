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

export function resolveSkcTmuxCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env[SKC_TMUX_COMMAND_ENV]?.trim() || env.SKC_TEAM_TMUX_COMMAND?.trim() || "tmux";
}

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
export function buildSkcTmuxExactOptionTarget(sessionName: string): string {
	return `=${sessionName}:`;
}

export const SKC_TMUX_UNTAGGED_REASON = "skc_tmux_session_untagged";

export function buildSkcTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return SKC's ${SKC_TMUX_PROFILE_OPTION} ownership tag; ` +
		"SKC-managed sessions and `skc team` require a tmux provider that round-trips tmux user options. " +
		"Alternative multiplexers such as psmux on Windows do not persist user options yet, so the Windows-native psmux path is not fully supported; " +
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
	return commands;
}

export function normalizeTmuxCreatedAt(raw: string): string {
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return raw;
	return new Date(seconds * 1000).toISOString();
}
