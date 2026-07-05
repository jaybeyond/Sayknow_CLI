# @sayknow-cli/coding-agent

Core implementation package for the `skc` coding agent in the `sayknow-cli` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/jaybeyond/Sayknow_CLI#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [DEVELOPMENT](./DEVELOPMENT.md)
- [RenderMermaid guide](../../docs/render-mermaid.md)

## External lifecycle notifications

SKC already exposes public lifecycle events through the extension/hook event contract. External notification integrations for Discord, Hermes, clawhip, or similar channels should be opt-in and subscribe to these events instead of scraping transcripts or logs:

- `turn_end` — a model/tool turn finished. The public payload is `{ type: "turn_end", turnIndex, message, toolResults }`.
- `agent_end` — the agent loop for a submitted prompt reached a terminal boundary. The public payload is `{ type: "agent_end", messages }`.

For simple local side effects that do not need a full extension, set the user-level `completion.notifyCommand`. SKC runs it on completed agent turns with `SKC_NOTIFICATION_*` environment variables (`SKC_NOTIFICATION_TITLE`, `SKC_NOTIFICATION_BODY`, `SKC_NOTIFICATION_JSON`, etc.); project settings cannot activate this command hook.

```sh
skc config set completion.notifyCommand 'cmux notify --title "$SKC_NOTIFICATION_TITLE" --body "$SKC_NOTIFICATION_BODY"'
```

When SKC runs inside a cmux terminal (`CMUX_WORKSPACE_ID` is set), SKC best-effort renames that cmux workspace to the current SKC session name (with a `SKC: ` prefix) — but only when the workspace still has its default title, so a name you pinned (or one set by a peer session sharing the workspace) is never overwritten. Opt out with `SKC_NO_CMUX_RENAME=1`.

Windows Terminal may keep BEL (`[Console]::Write([char]7)`) silent depending on profile and system sound settings even when `notifications.terminalBell` is enabled. For an audible Windows completion beep, configure a user-level PowerShell command hook instead:

```powershell
skc config set completion.notifyCommand 'powershell.exe -NoProfile -Command "[Console]::Beep(880, 300)"'
```

`cmux notify` returning successfully means SKC handed the completion event to cmux. cmux may still suppress the native desktop banner when the app/window is focused, the emitting workspace is active, or the notification panel is open. In those cases, check cmux's notification panel or unread workspace state instead of treating the missing banner as a SKC delivery failure.

Recommended external mapping:

| Notification | Public event | Status guidance |
|---|---|---|
| Turn finished | `turn_end` | Use the handler's own sanitized status such as `"finished"`. |
| Agent stopped/finished | `agent_end` | Treat as terminal for the prompt. |
| Waiting/blocked/failed | `agent_end` plus a caller-supplied safe summary | Current lifecycle events do not expose a separate structured waiting/blocked reason; inspect only public-safe, integration-owned state. |

Forward only a minimal, caller-sanitized payload. Do not include raw prompts, assistant transcripts, hidden prompts, tool outputs, raw logs, host paths, private config, webhook URLs, channel IDs, tokens, or secrets. A safe notification payload should be built by the extension/hook itself, for example:

```ts
import type { ExtensionAPI } from "@sayknow-cli/coding-agent";

type PublicLifecycleNotification = {
	type: "turn_end" | "agent_end";
	status: "finished" | "stopped" | "failed" | "blocked" | "waiting";
	turnIndex?: number;
	timestamp: string;
	summary: string;
};

export default function lifecycleNotifier(pi: ExtensionAPI) {
	const enabled = process.env.SKC_LIFECYCLE_NOTIFY === "1";
	if (!enabled) return;

	const send = async (payload: PublicLifecycleNotification) => {
		// POST to Discord/Hermes/clawhip here. Keep target URLs and channel IDs in
		// private config or environment variables; never include them in payloads.
	};

	pi.on("turn_end", event =>
		send({
			type: "turn_end",
			status: "finished",
			turnIndex: event.turnIndex,
			timestamp: new Date().toISOString(),
			summary: "SKC turn finished",
		}),
	);

	pi.on("agent_end", () =>
		send({
			type: "agent_end",
			status: "stopped",
			timestamp: new Date().toISOString(),
			summary: "SKC prompt reached a terminal lifecycle boundary",
		}),
	);
}
```

This is the supported repo-native lifecycle notification path. It is not Claude Code hook compatibility, and it remains disabled unless the user configures an extension/hook handler and private delivery target.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.skc/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker). Hindsight uses private backend lifecycle hooks to retain transcripts and recall context; compatibility-only internals remain for legacy backend calls, but SKC does not expose public coding-harness memory tools such as `retain`, `recall`, or `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session is honoured on the next system-prompt rebuild and the next `/memory` slash command. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.

## Blue-octopus TUI theme

The interactive TUI defaults to the bundled `blue-octopus` cephalopod theme for both dark and light terminals, with the bundled `red-octopus` theme as a warm, high-contrast alternate and matching welcome/icon assets. Three additional bundled migration themes — `claude-code`, `codex`, and `opencode` — mirror the look of those tools for easy eye-migration and are selectable from Settings or `/theme`. Explicit user theme settings still win; set `theme.dark: red-octopus` and `theme.light: blue-octopus` in `~/.skc/agent/config.yml` to pin them.
