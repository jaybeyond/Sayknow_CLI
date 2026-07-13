import { ProcessTerminal, TUI } from "@sayknow-cli/tui";
import { type SessionSelectionResult, SessionSelectorComponent } from "../modes/components/session-selector";
import { type SessionInfo, SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";

/** Show the read-only TUI session picker and return the user's consent intent. */
export async function selectSession(sessions: SessionInfo[]): Promise<SessionSelectionResult> {
	const { promise, resolve } = Promise.withResolvers<SessionSelectionResult>();
	const ui = new TUI(new ProcessTerminal());
	const storage = new FileSessionStorage();
	let settled = false;
	const settle = (selection: SessionSelectionResult): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		resolve(selection);
	};
	const selector = new SessionSelectorComponent(
		sessions,
		() => {},
		() => settle({ kind: "cancelled" }),
		() => settle({ kind: "cancelled" }),
		async session => {
			await storage.deleteSessionWithArtifacts(session.path);
			return true;
		},
		SessionManager.inspectSessionTailReadOnly,
		settle,
	);
	selector.setOnRequestRender(() => ui.requestRender());
	ui.addChild(selector);
	ui.setFocus(selector);
	ui.start();
	return promise;
}
