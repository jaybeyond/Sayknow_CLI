import {
	buildSkcTmuxExactOptionTarget,
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
		runTmux(["kill-session", "-t", `=${sessionName}`], env);
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
	};
}

function runListSessions(format: string, env: NodeJS.ProcessEnv = process.env): string[] {
	let output = "";
	try {
		output = runTmux(["list-sessions", "-F", format], env);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("no server running") || message.includes("failed to connect to server")) return [];
		throw error;
	}
	return output
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
}

function listSessionLines(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions(
		`#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{${SKC_TMUX_PROFILE_OPTION}}\t#{session_key_table}\t#{session_panes}\t#{pane_pid}\t#{${SKC_TMUX_BRANCH_OPTION}}\t#{${SKC_TMUX_BRANCH_SLUG_OPTION}}\t#{${SKC_TMUX_PROJECT_OPTION}}\t#{${SKC_TMUX_SESSION_ID_OPTION}}\t#{${SKC_TMUX_SESSION_STATE_FILE_OPTION}}`,
		env,
	);
}

function listRawTmuxSessionNames(env: NodeJS.ProcessEnv = process.env): string[] {
	return runListSessions("#{session_name}", env).map(line => line.split("\t")[0] ?? line);
}

export function listSkcTmuxSessions(env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionStatus[] {
	return listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is SkcTmuxSessionStatus => session?.profile === SKC_TMUX_PROFILE_VALUE)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal */
export function listTmuxSessionsForGc(env: NodeJS.ProcessEnv = process.env): SkcTmuxSessionsForGc {
	const sessions = listSessionLines(env)
		.map(parseSessionLine)
		.filter((session): session is SkcTmuxSessionStatus => session != null);
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
	const command = "exec env SKC_TMUX_LAUNCHED=1 skc";
	const created = Bun.spawnSync([tmuxCommand, "new-session", "-d", "-s", sessionName, command], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	if (created.exitCode !== 0) throw new Error(created.stderr.toString().trim() || "skc_tmux_session_create_failed");
	try {
		for (const profileCommand of buildSkcTmuxProfileCommands(sessionName, env)) {
			runTmux(profileCommand.args, env);
		}
	} catch (error) {
		tryKillSession(sessionName, env);
		throw error;
	}
	return statusSkcTmuxSession(sessionName, env);
}

function readProfileForExactTarget(sessionName: string, env: NodeJS.ProcessEnv): string {
	return runTmux(
		["show-options", "-qv", "-t", buildSkcTmuxExactOptionTarget(sessionName), SKC_TMUX_PROFILE_OPTION],
		env,
	).trim();
}

function readExactOptionForGc(sessionName: string, option: string, env: NodeJS.ProcessEnv): string | undefined {
	try {
		return (
			runTmux(["show-options", "-qv", "-t", buildSkcTmuxExactOptionTarget(sessionName), option], env).trim() ||
			undefined
		);
	} catch {
		return undefined;
	}
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
	runTmux(["kill-session", "-t", `=${session.name}`], env);
	return session;
}

export function attachSkcTmuxSession(sessionName: string, env: NodeJS.ProcessEnv = process.env): never {
	const session = statusSkcTmuxSession(sessionName, env);
	const tmuxCommand = resolveSkcTmuxCommand(env);
	const result = Bun.spawnSync([tmuxCommand, "attach-session", "-t", `=${session.name}`], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env,
	});
	process.exit(result.exitCode ?? 1);
}
