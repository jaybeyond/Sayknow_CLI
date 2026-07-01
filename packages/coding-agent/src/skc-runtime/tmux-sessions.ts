import { resolveSkcTmuxBinary } from "./psmux-detect";
import {
	buildSkcTmuxExactOptionTarget,
	buildSkcTmuxExactSessionTarget,
	buildSkcTmuxProfileCommands,
	buildSkcTmuxSessionName,
	buildSkcTmuxUntaggedSessionError,
	normalizeTmuxCreatedAt,
	resolveSkcTmuxCommand,
	SKC_TMUX_BRANCH_OPTION,
	SKC_TMUX_BRANCH_SLUG_OPTION,
	SKC_TMUX_PROFILE_OPTION,
	SKC_TMUX_PROFILE_VALUE,
	SKC_TMUX_PROJECT_OPTION,
	SKC_TMUX_SESSION_ID_OPTION,
	SKC_TMUX_SESSION_STATE_FILE_OPTION,
	SKC_TMUX_VERSION_OPTION,
} from "./tmux-common";

export interface SkcTmuxSessionStatus {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
	branch?: string;
	branchSlug?: string;
	project?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	panePids: number[];
	profile?: string;
}

export interface SkcTmuxSessionTagsForGc {
	profile?: string;
	project?: string;
	branch?: string;
	branchSlug?: string;
	sessionId?: string;
	sessionStateFile?: string;
	version?: string;
	createdAt?: string;
	attached?: boolean;
	panePids?: number[];
}

export interface SkcTmuxSessionsForGc {
	tagged: SkcTmuxSessionStatus[];
	untagged: SkcTmuxSessionStatus[];
}

function runTmux(args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const tmuxCommand = resolveSkcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, ...args], { stdout: "pipe", stderr: "pipe", env });
	if (result.exitCode === 0) return result.stdout.toString();
	throw new Error(result.stderr.toString().trim() || `tmux ${args.join(" ")} failed`);
}

function tryKillSession(sessionName: string, env: NodeJS.ProcessEnv): void {
	try {
		runTmux(["kill-session", "-t", buildSkcTmuxExactSessionTarget(sessionName, { env })], env);
	} catch {
		// Best-effort cleanup only; preserve the original create/tag failure.
	}
}

function parseBooleanFlag(value: string | undefined): boolean {
	return value === "1";
}

function parseNumber(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseSessionLine(line: string): SkcTmuxSessionStatus | null {
	const [
		name = "",
		windows = "0",
		attached = "0",
		created = "",
		profile = "",
		bindings = "",
		panes = "0",
		panePids = "",
		branch = "",
		branchSlug = "",
		project = "",
		sessionId = "",
		sessionStateFile = "",
		version = "",
	] = line.split("\t");
	if (!name) return null;
	return {
		name,
		attached: parseBooleanFlag(attached),
		windows: parseNumber(windows),
		panes: parseNumber(panes),
		panePids: panePids
			.split(",")
			.map(pid => parseNumber(pid))
			.filter(pid => pid > 0),
		bindings,
		createdAt: normalizeTmuxCreatedAt(created),
		branch: branch || undefined,
		branchSlug: branchSlug || undefined,
		project: project || undefined,
		profile: profile || undefined,
		sessionId: sessionId || undefined,
		sessionStateFile: sessionStateFile || undefined,
		version: version || undefined,
	};
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): string[] {
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("no server running") ||
			message.includes("failed to connect to server") ||
			message.includes("error connecting to")
		) {
			return [];
		}
		throw error;
	}
	const lines = output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	// psmux 3.3.0 silently ignores the tmux `-F` format flag and returns its
	// default `name: N windows (created ...)` shape. Detect that case and
	// synthesize a tab-separated row so downstream parseSessionLine /
	// hydrateSessionFromExactOptions can recover the @skc-* ownership tags
	// via follow-up show-options calls. Without this fallback skc session
	// list / status return an empty list on psmux even when sessions exist.
	if (lines.length > 0 && !lines[0].includes("\t")) {
		const binary = resolveSkcTmuxBinary({ env });
		if (binary.isPsmux) {
			return lines.map(line => {
				const match = line.match(/^([^:]+):\s*(\d+)\s+windows?\s+\(created\s+([^)]+)\)/);
				if (!match) return line;
				const [, name, windows, created] = match;
				const createdEpoch = String(Math.floor(new Date(`${created} UTC`).getTime() / 1000) || 0);
				return [name, windows, "0", createdEpoch, "", "", "0", "", "", "", "", "", "", ""].join("\t");
			});
		}
	}
	return lines;
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${SKC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${SKC_TMUX_BRANCH_OPTION}}\t#{${SKC_TMUX_BRANCH_SLUG_OPTION}}\t#{${SKC_TMUX_PROJECT_OPTION}}\t#{${SKC_TMUX_SESSION_ID_OPTION}}\t#{${SKC_TMUX_SESSION_STATE_FILE_OPTION}}\t#{${SKC_TMUX_VERSION_OPTION}}`,
		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions("#{session_name}", env).map(line => line.split("\t")[0] ?? line);
}

export function listSkcTmuxSessions(env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionStatus[] {
	return listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is SkcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env))
		.filter((session): session is SkcTmuxSessionStatus => session?.profile === SKC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionsForGc {
	const sessions = listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is SkcTmuxSessionStatus => session != null)
		.map(session => hydrateSessionFromExactOptions(session, env));
	const tagged = sessions
		.filter(session => session.profile === SKC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
	const taggedNames = new Set(tagged.map(session => session.name));
	const byName = new Map(sessions.map(session => [session.name, session]));
	const untagged = listRawTmuxSessionNames(env)
		.filter(name => !taggedNames.has(name))
		.map(
			name =>
				byName.get(name) ?? {
					name,
					attached: false,
					windows: 0,
					panes: 0,
					panePids: [],
					bindings: "",
					createdAt: "",
				},
		)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { tagged, untagged };
}

export function findSkcTmuxSessionByBranch(
	branch: string,
	env: NodeJS.ProcessEnv = process.env,
	project?: string | null,
): SkcTmuxSessionStatus | undefined {
	return listSkcTmuxSessions(env).find(
		session => session.branch === branch && (!project || session.project === project),
	);
}

export function findSkcTmuxSessionByName(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): SkcTmuxSessionStatus | undefined {
	return listSkcTmuxSessions(env).find(session => session.name === sessionName);
}

export function findSkcTmuxSessionByScope(
	project: string,
	branch: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): SkcTmuxSessionStatus | undefined {
	return listSkcTmuxSessions(env).find(
		session => session.project === project && (branch ? session.branch === branch : session.branch === undefined),
	);
}
export function statusSkcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionStatus {
	const session = listSkcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	if (session) return session;
	if (listRawTmuxSessionNames(env).includes(sessionName)) {
		throw new Error(buildSkcTmuxUntaggedSessionError(sessionName, resolveSkcTmuxCommand(env)));
	}
	throw new Error(`skc_tmux_session_not_found:${sessionName}`);
}

export function createSkcTmuxSession(env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionStatus {
	const tmuxCommand = resolveSkcTmuxCommand(env);
	const sessionName = buildSkcTmuxSessionName(env);
	// Build a shell-bootstrap command appropriate for the host shell. Psmux on
	// Windows runs the new-session command through PowerShell, so we use the
	// $env:VAR = ... assignment form there. POSIX keeps the historical exec
	// env form so the launched skc inherits SKC_TMUX_LAUNCHED without leaking
	// into the parent tmux server.
	const platform = process.platform;
	const command = platform === "win32" ? "$env:SKC_TMUX_LAUNCHED = '1'; skc" : "exec env SKC_TMUX_LAUNCHED=1 skc";
	const created = Bun.spawnSync([tmuxCommand, "new-session", "-d", "-s", sessionName, command], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || "skc_tmux_session_create_failed");
	try {
		// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix for option
		// commands, so the target is the bare session name on psmux and the
		// window-qualified `=NAME:` on tmux. The ownership-tag round-trip
		// (set-option @skc-*) is preserved on both; only the UX profile commands
		// (mouse / set-clipboard / mode-style / set-window-option) get filtered
		// by buildSkcTmuxProfileCommands when the active binary is psmux.
		const target = buildSkcTmuxExactOptionTarget(sessionName, { env });
		for (const profileCommand of buildSkcTmuxProfileCommands(target, env, {}, { tmuxCommand })) {
			runTmux(profileCommand.args, env);
		}
	} catch (error) {
		tryKillSession(sessionName, env);
		throw error;
	}
	return statusSkcTmuxSession(sessionName, env);
}

function readProfileForExactTarget(sessionName: string, env: NodeJS.ProcessEnv): string {
	const raw = runTmux(
		["show-options", "-qv", "-t", buildSkcTmuxExactOptionTarget(sessionName, { env }), SKC_TMUX_PROFILE_OPTION],
		env,
	).trim();
	// tmux returns just the value; psmux returns `key value`. Strip the
	// leading key on psmux so the SKC_TMUX_PROFILE_VALUE equality check
	// against "1" works the same on both.
	if (raw && resolveSkcTmuxBinary({ env }).isPsmux) {
		const tokens = raw.split(/\s+/).filter(Boolean);
		return tokens[tokens.length - 1] ?? raw;
	}
	return raw;
}

function readExactOptionForGc(sessionName: string, option: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		const raw = runTmux(
			["show-options", "-qv", "-t", buildSkcTmuxExactOptionTarget(sessionName, { env }), option],
			env,
		).trim();
		if (!raw) return undefined;
		// tmux returns just the option value (e.g. `1` for @skc-profile).
		// psmux 3.3.0 returns `key value` (or `key "value with space"` for
		// @skc-branch etc.). On psmux, parse the last token and strip any
		// surrounding double quotes so both shapes resolve to the same value.
		if (resolveSkcTmuxBinary({ env }).isPsmux) {
			// Prefer the last whitespace-separated token. If the value is
			// quoted, find the matching close-quote and slice.
			const lastQuote = raw.lastIndexOf('"');
			if (lastQuote > 0 && raw[lastQuote - 1] !== "\\") {
				const firstQuote = raw.lastIndexOf('"', lastQuote - 1);
				if (firstQuote > 0) return raw.slice(firstQuote + 1, lastQuote);
			}
			const tokens = raw.split(/\s+/).filter(Boolean);
			return tokens[tokens.length - 1];
		}
		return raw;
	} catch {
		return undefined;
	}
}

function hydrateSessionFromExactOptions(session: SkcTmuxSessionStatus, env: NodeJS.ProcessEnv): SkcTmuxSessionStatus {
	if (session.profile === SKC_TMUX_PROFILE_VALUE) return session;
	const profile = readExactOptionForGc(session.name, SKC_TMUX_PROFILE_OPTION, env);
	if (profile !== SKC_TMUX_PROFILE_VALUE) return session;
	return {
		...session,
		profile,
		branch: session.branch ?? readExactOptionForGc(session.name, SKC_TMUX_BRANCH_OPTION, env),
		branchSlug: session.branchSlug ?? readExactOptionForGc(session.name, SKC_TMUX_BRANCH_SLUG_OPTION, env),
		project: session.project ?? readExactOptionForGc(session.name, SKC_TMUX_PROJECT_OPTION, env),
		sessionId: session.sessionId ?? readExactOptionForGc(session.name, SKC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile:
			session.sessionStateFile ?? readExactOptionForGc(session.name, SKC_TMUX_SESSION_STATE_FILE_OPTION, env),
		version: session.version ?? readExactOptionForGc(session.name, SKC_TMUX_VERSION_OPTION, env),
	};
}

/** @internal */
export function readTmuxSessionTagsForGc(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
): SkcTmuxSessionTagsForGc {
	const session = listSkcTmuxSessions(env).find(candidate => candidate.name === sessionName);
	return {
		profile: readExactOptionForGc(sessionName, SKC_TMUX_PROFILE_OPTION, env),
		project: readExactOptionForGc(sessionName, SKC_TMUX_PROJECT_OPTION, env),
		branch: readExactOptionForGc(sessionName, SKC_TMUX_BRANCH_OPTION, env),
		branchSlug: readExactOptionForGc(sessionName, SKC_TMUX_BRANCH_SLUG_OPTION, env),
		sessionId: readExactOptionForGc(sessionName, SKC_TMUX_SESSION_ID_OPTION, env),
		sessionStateFile: readExactOptionForGc(sessionName, SKC_TMUX_SESSION_STATE_FILE_OPTION, env),
		version: readExactOptionForGc(sessionName, SKC_TMUX_VERSION_OPTION, env),
		createdAt: session?.createdAt,
		attached: session?.attached,
		panePids: session?.panePids,
	};
}

export function removeSkcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionStatus {
	const session = statusSkcTmuxSession(sessionName, env);
	if (session.attached || session.panePids.length > 0) {
		throw new Error(`skc_tmux_session_live:${sessionName}`);
	}
	if (readProfileForExactTarget(session.name, env) !== SKC_TMUX_PROFILE_VALUE) {
		throw new Error(`skc_tmux_session_not_managed:${sessionName}`);
	}
	runTmux(["kill-session", "-t", buildSkcTmuxExactSessionTarget(session.name, { env })], env);
	return session;
}

/**
 * Force-close a SKC-managed tmux session, even if a live pane is attached.
 *
 * This is the lifecycle-control counterpart to {@link removeSkcTmuxSession}: it
 * intentionally does NOT refuse live/attached panes (hard-kill is the contract),
 * but it keeps every safety check so it can only ever kill a genuinely
 * SKC-managed session:
 * - re-reads the exact tmux profile immediately before kill (never a non-SKC
 *   session, even one that collides by name);
 * - when `expectedSessionId` is given, requires the `@skc-session-id` tag match;
 * - when `expectedStateFile` is given, requires the `@skc-session-state-file`
 *   tag match.
 *
 * Returns the prior status (for audit). Throws a tagged error otherwise:
 * `skc_tmux_session_not_found`, `skc_tmux_session_not_managed`,
 * `skc_tmux_session_id_mismatch`, or `skc_tmux_session_state_file_mismatch`.
 */
export function forceCloseSkcTmuxSession(
	sessionName: string,
	env: NodeJS.ProcessEnv = process.env,
	expectedSessionId?: string,
	expectedStateFile?: string,
): SkcTmuxSessionStatus {
	const session = statusSkcTmuxSession(sessionName, env);
	if (readProfileForExactTarget(session.name, env) !== SKC_TMUX_PROFILE_VALUE) {
		throw new Error(`skc_tmux_session_not_managed:${sessionName}`);
	}
	if (expectedSessionId !== undefined) {
		const actual = readExactOptionForGc(session.name, SKC_TMUX_SESSION_ID_OPTION, env);
		if (actual !== expectedSessionId) {
			throw new Error(`skc_tmux_session_id_mismatch:${sessionName}`);
		}
	}
	if (expectedStateFile !== undefined) {
		const actual = readExactOptionForGc(session.name, SKC_TMUX_SESSION_STATE_FILE_OPTION, env);
		if (actual !== expectedStateFile) {
			throw new Error(`skc_tmux_session_state_file_mismatch:${sessionName}`);
		}
	}
	// Intentionally NOT refusing live/attached panes — force-close is hard-kill.
	runTmux(["kill-session", "-t", buildSkcTmuxExactSessionTarget(session.name, { env })], env);
	return session;
}

export function attachSkcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	const session = statusSkcTmuxSession(sessionName, env);
	const tmuxCommand = resolveSkcTmuxCommand(env);
	const result = Bun.spawnSync(
		[tmuxCommand, "attach-session", "-t", buildSkcTmuxExactSessionTarget(session.name, { env })],
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env,
		},
	);
	process.exit(result.exitCode ?? 1);
}
