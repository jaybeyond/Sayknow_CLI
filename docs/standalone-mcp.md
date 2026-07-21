# Standalone MCP configuration

`skc mcp add` writes only the definition supplied on that invocation to SKC's own MCP config (`~/.skc/agent/mcp.json` by default, or `./.skc/mcp.json` with `--project`). `skc mcp list` and `skc mcp remove` print redacted definitions. These commands are storage-only: normal standalone startup does not consume registered definitions.

## Use an explicit config

A caller can opt one top-level standalone session into one trusted config file:

```bash
skc --mcp-config /absolute/path/to/mcp.json
```

The path must be absolute and identify a regular file directly; symbolic links and other indirection are rejected. SKC reads the file through one open handle and rejects it if the path, file identity, size, or modification metadata changes during the read. It exposes only that file's MCP tools and owns the server processes for that session. It does not load server prompts, resources, instructions, sampling, or other config files. Expected read, parse, validation, and connection failures emit one sanitized warning and continue. Unexpected errors and final-catalog tool-name collisions clean up and abort startup.

There is no MCP config discovery or merge, reload while the session runs, subagent inheritance, or default behavior change. To use a stored registration, pass that exact stored config path with `--mcp-config`.

## Supported integrations

| Need | Use | Notes |
| --- | --- | --- |
| User trusts one MCP config for one standalone session | `skc --mcp-config /absolute/path/to/mcp.json` | Exact-file, top-level, tools-only opt-in; SKC owns cleanup. |
| External bot or multi-session controller | [Coordinator MCP](./hermes-mcp-bridge.md) | Coordinator MCP exposes SKC lifecycle and coordination tools. |
| External session control | [SDK machine interface](./sdk.md) | The SDK WebSocket protocol is the only external control interface. |
| Editor/ACP client owns MCP servers | ACP via `skc --mode acp` or `skc acp` | ACP remains a stdio editor protocol. |
| Codex / Claude Code delegation plugin | [Canonical sayknow-cli plugin](./hermes-mcp-bridge.md) | Installs Coordinator MCP plus SKC delegation commands. |

## Boundary

Standalone SKC does not inherit arbitrary MCP server configurations from Claude Code, Codex, OpenCode, or other tools. MCP servers often carry credentials, filesystem reach, browser state, approval semantics, and lifecycle that belong to the configuring host.

`--mode rpc`, `--mode rpc-ui`, and `--mode bridge` have been removed. Do not use the former RPC host-tool protocol to connect an MCP server; use the [SDK machine interface](./sdk.md) for supported external session control.

## Related docs

- [SDK machine interfaces](./sdk.md)
- [Coordinator MCP bridge](./hermes-mcp-bridge.md)
- [External control surface readiness](./external-control-readiness.md)