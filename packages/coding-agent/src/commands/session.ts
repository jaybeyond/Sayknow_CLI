import { Args, Command, Flags } from "@sayknow-cli/utils/cli";
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
	static description = "List, inspect, attach, and remove tagged SKC-managed tmux sessions";
	static strict = false;

	static args = {
		action: Args.string({
			description: "list (default), status, create, attach, or remove",
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
	};

	static examples = [
		"skc session list",
		"skc session create",
		"skc session status <session>",
		"skc session attach <session>",
		"skc session remove <session>",
		"skc session force-close <session> --session-id <id>",
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
				const closed = forceCloseSkcTmuxSession(sessionName, process.env, flags["session-id"], flags["state-file"]);
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
