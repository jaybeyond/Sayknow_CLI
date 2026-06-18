# @sayknow-cli/coding-agent

Core implementation package for the `skc` coding agent in the `sayknow-cli` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/jaybeyond/Sayknow_CLI#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [DEVELOPMENT](./DEVELOPMENT.md)
- [RenderMermaid guide](../../docs/render-mermaid.md)

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
