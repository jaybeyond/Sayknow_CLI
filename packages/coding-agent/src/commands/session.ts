import { Args, Command, Flags } from "@sayknow-cli/utils/cli";
import { readBootGeneration } from "../skc-runtime/boot-generation";
import {
	decodeRestoreReference,
	encodeRestoreReference,
	evaluateRestoreCandidates,
	listRestorePointers,
	type RestoreCandidateVerdict,
} from "../skc-runtime/session-restore";
import { buildRestoreCandidateDeps, restoreSession } from "../skc-runtime/session-restore-runtime";
import {
	attachSkcTmuxSession,
	createSkcTmuxSession,
	forceCloseSkcTmuxSession,
	listSkcTmuxSessions,
	removeSkcTmuxSession,
	statusSkcTmuxSession,
} from "../skc-runtime/tmux-sessions";

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function writeJsonFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const [reason = "session_error"] = message.split(":");
	const hintIndex = message.indexOf(" — ");
	const detail = hintIndex >= 0 ? message.slice(hintIndex + " — ".length).trim() : "";
	writeJson(detail ? { ok: false, reason, detail } : { ok: false, reason });
}

interface SessionJsonDto {
	name: string;
	attached: boolean;
	windows: number;
	panes: number;
	bindings: string;
	createdAt: string;
}

function sessionJson(session: SessionJsonDto): SessionJsonDto {
	return {
		name: session.name,
		attached: session.attached,
		windows: session.windows,
		panes: session.panes,
		bindings: session.bindings,
		createdAt: session.createdAt,
	};
}

export default class Session extends Command {
	static description =
		"List, inspect, attach, and remove tagged SKC-managed tmux sessions. `restore` is a manual, opt-in recovery step that only ever restores sessions this machine can prove died in a REBOOT: nothing starts automatically at login, a session that is still live is never duplicated, and running tools or background work are not recovered — only the tmux session, its directory, and its conversation.";
	static strict = false;

	static args = {
		action: Args.string({
			description: "list (default), status, create, attach, remove, or restore",
			required: false,
		}),
		session: Args.string({
			description: "Session name for status, attach, or remove",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		"session-id": Flags.string({
			description: "Expected @skc-session-id tag for force-close (defense-in-depth match)",
		}),
		"state-file": Flags.string({
			description: "Expected @skc-session-state-file tag for force-close (defense-in-depth match)",
		}),
		"dry-run": Flags.boolean({
			description:
				"restore: list candidates and their verdicts. Changes nothing at all (no tmux command, no lock, no database, no pointer write). This is the default when no --reference is given.",
			default: false,
		}),
		reference: Flags.string({
			description:
				"restore: restore exactly one candidate by the opaque reference shown in --dry-run output. Refused unless that candidate is still reboot-eligible at this moment.",
		}),
	};

	static examples = [
		"skc session list",
		"skc session create",
		"skc session status <session>",
		"skc session attach <session>",
		"skc session remove <session>",
		"skc session force-close <session> --session-id <id>",
		"skc session restore --dry-run   # list what a reboot left behind",
		"skc session restore --reference <ref>   # restore exactly that one",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Session);
		const action = args.action ?? "list";
		const sessionName = args.session;
		const json = flags.json ?? false;
		try {
			if (action === "list") {
				const sessions = listSkcTmuxSessions();
				if (json) {
					writeJson({ ok: true, sessions: sessions.map(sessionJson) });
					return;
				}
				writeText(
					sessions.map(session =>
						[
							session.name,
							`windows=${session.windows}`,
							`attached=${session.attached}`,
							`createdAt=${session.createdAt}`,
							`panes=${session.panes}`,
							`bindings=${session.bindings || "none"}`,
						].join("\t"),
					),
				);
				return;
			}

			if (action === "restore") {
				// Manual, reboot-proven, opt-in. Nothing here starts automatically at
				// login, and a session is only ever restored when this host can prove
				// the machine rebooted since that session was recorded.
				const reference = flags.reference;
				const decoded = reference ? decodeRestoreReference(reference) : null;
				if (reference && !decoded) throw new Error("invalid_restore_reference");
				const pointers = listRestorePointers().filter(
					pointer =>
						!decoded ||
						(pointer.coordinator_session_id === decoded.coordinatorSessionId &&
							pointer.state_file === decoded.stateFile),
				);
				if (reference && pointers.length === 0) throw new Error("restore_reference_not_found");
				const verdicts = evaluateRestoreCandidates(pointers, buildRestoreCandidateDeps(readBootGeneration()));
				const describe = (verdict: RestoreCandidateVerdict) => ({
					reference: encodeRestoreReference(verdict.pointer.coordinator_session_id, verdict.pointer.state_file),
					sessionId: verdict.pointer.skc_session_id,
					cwd: verdict.pointer.cwd,
					branch: verdict.pointer.branch,
					eligible: verdict.eligible,
					...(verdict.eligible ? {} : { reason: verdict.reason }),
				});
				// Dry run is the default reporting surface and performs zero mutation:
				// no pointer write, no lock, no SQLite, no tmux command.
				if (flags["dry-run"] || !reference) {
					const rows = verdicts.map(describe);
					if (json) {
						writeJson({ ok: true, dryRun: true, candidates: rows });
						return;
					}
					writeText(
						rows.length === 0
							? ["no restore candidates"]
							: rows.map(row =>
									[
										row.eligible ? "restorable" : `skipped(${row.reason})`,
										row.sessionId,
										row.cwd,
										row.reference,
									].join("\t"),
								),
					);
					return;
				}
				const verdict = verdicts[0];
				if (!verdict) throw new Error("restore_reference_not_found");
				if (!verdict.eligible) throw new Error(`restore_ineligible_${verdict.reason}`);
				const outcome = restoreSession(verdict.pointer);
				if (!outcome.ok) throw new Error(outcome.detail);
				if (json) {
					writeJson({
						ok: true,
						restored: {
							sessionId: outcome.pointer.skc_session_id,
							cwd: outcome.pointer.cwd,
							tmuxSession: outcome.tmuxSession,
						},
					});
					return;
				}
				writeText([`restored: ${outcome.tmuxSession} (${outcome.pointer.skc_session_id})`]);
				return;
			}

			if (action === "create") {
				const session = createSkcTmuxSession();
				if (json) {
					writeJson({ ok: true, session: sessionJson(session) });
					return;
				}
				writeText([`created: ${session.name}`]);
				return;
			}

			if (!sessionName) throw new Error("missing_session_name");

			if (action === "status") {
				const session = statusSkcTmuxSession(sessionName);
				if (json) {
					writeJson({ ok: true, session: sessionJson(session) });
					return;
				}
				writeText([
					`session: ${session.name}`,
					`windows: ${session.windows}`,
					`attached: ${session.attached}`,
					`createdAt: ${session.createdAt}`,
					`panes: ${session.panes}`,
					`bindings: ${session.bindings || "none"}`,
				]);
				return;
			}

			if (action === "remove" || action === "rm" || action === "delete") {
				const removed = removeSkcTmuxSession(sessionName);
				if (json) {
					writeJson({ ok: true, session: sessionJson(removed) });
					return;
				}
				writeText([`removed: ${removed.name}`]);
				return;
			}

			if (action === "force-close" || action === "force-remove") {
				const closed = await forceCloseSkcTmuxSession(
					sessionName,
					process.env,
					flags["session-id"],
					flags["state-file"],
				);
				if (json) {
					writeJson({ ok: true, session: sessionJson(closed) });
					return;
				}
				writeText([`force-closed: ${closed.name}`]);
				return;
			}

			if (action === "attach") {
				attachSkcTmuxSession(sessionName);
				return;
			}
			throw new Error(`unknown_session_action:${action}`);
		} catch (error) {
			if (json) {
				writeJsonFailure(error);
				return;
			}
			throw error;
		}
	}
}
