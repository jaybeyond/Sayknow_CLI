# External control surface readiness

This document classifies every public SKC surface that an external controller, bot, editor, or harness can use to drive `skc`. It is intentionally narrower than the generic bot guide: it states what is ready today, what is only editor/client-oriented, and what remains experimental.

## Readiness matrix

| Surface | Current readiness | Primary command | Use when | Do not use when | Provider-independent smoke path |
| --- | --- | --- | --- | --- | --- |
| Coordinator MCP | Preferred multi-session bot/control-plane surface. | `skc mcp-serve coordinator` | A controller needs to start/register SKC sessions, send bounded turns, answer questions, read artifacts, and write durable status reports across one or more repo/worktree lanes. | The controller only needs one embedded subprocess and can own stdio directly. | `skc mcp-serve coordinator --check --json`; `packages/coding-agent/test/coordinator-mcp.test.ts`; `packages/coding-agent/test/setup-cli.test.ts`. |
| RPC stdio | Stable subprocess worker surface. | `skc --mode rpc` | A host embeds one SKC worker process, sends JSONL commands over stdin, consumes stdout frames, and optionally uses `python/skc-rpc`. | The host needs remote HTTPS, multi-session orchestration, or MCP tool discovery. | `packages/coding-agent/test/rpc-unattended-stdio.test.ts`; `packages/coding-agent/test/rpc-client.start.test.ts`; `packages/coding-agent/test/rpc-host-tools.test.ts`; `packages/coding-agent/test/rpc-host-uris.test.ts`. |
| ACP mode | Editor/ACP client surface with tested protocol initialization, session lifecycle, client-owned MCP, file/terminal client bridges, permission routing, and stdout hygiene. | `skc --mode acp` or `skc acp` | An editor or ACP-compatible client wants to drive SKC through the Agent Client Protocol over stdio. | A bot needs a generic multi-session control plane; use Coordinator MCP instead. | `packages/coding-agent/test/acp-initialize-conformance.test.ts`; `packages/coding-agent/test/acp-stdout-hygiene.test.ts`; `packages/coding-agent/test/acp-lazy-startup.test.ts`; `packages/coding-agent/test/acp-mcp-isolation.test.ts`; `packages/coding-agent/test/read-acp-fs.test.ts`; `packages/coding-agent/test/write-acp-fs.test.ts`; `packages/coding-agent/test/bash-acp-terminal.test.ts`. |
| Bridge HTTPS | Experimental, fail-closed remote session-control surface. | `skc --mode bridge` | A future remote client needs HTTPS protocol scaffolding, authenticated health/help/handshake behavior, or SDK compatibility tests. | Production bot lifecycle, default external-controller integration, or claims that remote session events/commands are enabled by default. | `packages/coding-agent/test/bridge/bridge-auth.test.ts`; `packages/coding-agent/test/bridge/bridge-mode-handler.test.ts`; `packages/coding-agent/test/bridge/bridge-conformance.test.ts`; `packages/bridge-client/test/bridge-client.test.ts`. |

## Surface details

### Standalone TUI and MCP inheritance

Normal standalone SKC (`skc`, `skc --tmux`, and print-mode prompts) does not inherit Claude Code, Codex, Cursor, Gemini, Windsurf, or other tools' MCP servers as a public startup contract. It also does not expose a supported standalone-TUI setting that automatically imports arbitrary MCP servers for the model. See [Standalone SKC MCP support](./standalone-mcp.md) for the user-facing boundary and workarounds.

### Coordinator MCP

Coordinator MCP is the default answer for external bot and orchestration integrations. It exposes a transport-level MCP tool contract for session discovery, managed session start, visible tmux registration, prompt delivery, bounded turn waiting, structured question answering, artifact reads, and explicit completion/failure/cancellation reports.
It also exposes high-level `skc_delegate_plan` / `skc_delegate_execute` / `skc_delegate_team` tools so a host can delegate a whole SKC workflow (ralplan/ultragoal/team) in one call and consume the durable turn result. The canonical sayknow-cli plugin bundles under `plugins/` and `skc setup claude|codex|hermes` package this surface with fail-closed defaults (workdir-scoped roots, mutations off until opt-in). Claude Code is installable through its generated local marketplace; Codex artifacts are preview-only until a versioned Codex local marketplace smoke proves install and runtime activation.

### JetBrains Air custom agent

Add SKC through Air's **Add Custom Agent** action, then configure the Air-managed `acp.json`. With only `["acp"]`, Air shows SKC's existing model list. Add `--mpreset <id>` only when the Air model selector should show the available SKC preset list and create new sessions with that preset.

The following example starts the `opus-codex` model preset and allows tool calls without permission prompts:

```json
{
  "agent_servers": {
    "Sayknow-Local-Opus": {
      "command": "/absolute/path/to/skc",
      "args": ["acp", "--mpreset", "opus-codex"],
      "env": {
        "SKC_ACP_PERMISSION_MODE": "always-allow"
      }
    }
  }
}
```

`always-allow` gives the agent permission to execute gated tools, including shell commands, without an Air approval prompt. Omit `SKC_ACP_PERMISSION_MODE` or set it to `prompt` when manual approval is required. Start a new Air task after changing `acp.json`; restart Air if it reuses an already-running agent process.

Air supplies MCP servers through ACP session requests. SKC accepts client-supplied stdio, HTTP, and SSE definitions for new sessions and offline resume. Do not add `--mcp-config` to the ACP command: that CLI option is intentionally unsupported for broker-backed ACP. A live session's MCP configuration is immutable; close or resume the offline session to change it.

Air-created Git worktrees are supported because each ACP request's absolute `cwd` becomes the session workspace. Additional ACP workspace roots are not currently supported and are rejected instead of being advertised.

Session title and update metadata are advisory state for the active ACP process. Text, thought, tool-call, and tool-result history is replayed on load, but historical binary image bytes are not replayed.

See [Environment Variables](./environment-variables.md#11-acp-permission-handling) for supported values and precedence.

## Verification references

- Ready as the preferred generic external-controller control plane.
- Provider-independent contract checks exist for server metadata, tool discovery, read-only defaults, mutation gates, setup rendering, and dry-run lifecycle behavior.
- It is not a provider/model contract. Live model execution remains the operator's environment-specific smoke.

Primary references:

- `docs/bot-integration.md`
- `docs/hermes-mcp-bridge.md`
- `packages/coding-agent/src/coordinator/contract.ts`
- `packages/coding-agent/src/coordinator-mcp/server.ts`

### RPC stdio

RPC mode is the stable embedded-worker surface. It is newline-delimited JSON over stdio and emits a `{ "type": "ready" }` frame before accepting commands. Hosts can drive prompts, state queries, host tools, host URI schemes, workflow gates, extension UI responses, cancellation, and unattended negotiation through the RPC command catalog.

Readiness claim:

- Ready for single-process host integration and subprocess workers.
- The public Python client in `python/skc-rpc` is the recommended typed client for Python hosts.
- Multi-session orchestration and MCP tool discovery are out of scope for RPC; use Coordinator MCP for those.

Primary references:

- `docs/rpc.md`
- `python/skc-rpc/README.md`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`

### ACP mode

ACP mode runs SKC as an Agent Client Protocol server over stdio. It is useful for editor-style clients that own the ACP transport and want session creation, session load/fork/resume/close metadata, prompt handling, client-provided MCP servers, permission prompts, editor file reads/writes, terminal-backed bash, and elicitation support.

Readiness claim:

- ACP is implemented and covered for current editor/client contracts: initialize conformance, agent capability advertisement, lazy startup, stdout JSON-RPC hygiene, client-owned MCP isolation, event mapping, file bridge routing, terminal routing, and permission routing.
- ACP is not the preferred bot control-plane surface. It is not positioned as a multi-session external bot coordinator, and it does not replace Coordinator MCP reports/artifacts/turn state.
- A real prompt still depends on the selected provider/model credentials, so required PR smokes should stay on provider-independent initialize, lifecycle, bridge, and mapper tests.

Current entrypoints:

```sh
skc --mode acp
# equivalent ACP subcommand for ACP clients that prefer command-style launch
skc acp
```

Primary references:

- `packages/coding-agent/src/commands/acp.ts`
- `packages/coding-agent/src/modes/acp/acp-mode.ts`
- `packages/coding-agent/src/modes/acp/acp-agent.ts`
- `packages/coding-agent/src/modes/acp/acp-client-bridge.ts`
- `packages/coding-agent/src/modes/acp/acp-event-mapper.ts`

### Bridge HTTPS

Bridge mode is an experimental network protocol surface over HTTPS. Its current public posture is deliberately fail-closed: unauthenticated health/help are available, authenticated handshake is available, and default session-control endpoints advertise no accepted capabilities/scopes and reject with `endpoint_disabled`.

Readiness claim:

- Ready as experimental protocol scaffolding with fail-closed behavior and SDK/client conformance tests.
- Not ready as the default external-bot product surface.
- Do not document events, commands, controller ownership, UI responses, host tool results, or host URI results as enabled by default. Those names remain in the protocol catalog for internal compatibility and future re-enable work.

Primary references:

- `docs/bridge.md`
- `packages/coding-agent/src/modes/bridge/bridge-mode.ts`
- `packages/coding-agent/src/modes/bridge/auth.ts`
- `packages/bridge-client/src/index.ts`

## PR smoke checklist

For external-control PRs, use this provider-independent checklist before any optional live provider smoke:

1. **Docs-to-code alignment:** the readiness matrix still matches CLI mode parsing, MCP command registration, ACP command registration, bridge endpoint defaults, and RPC/ACP/Bridge tests.
2. **Coordinator MCP:** `skc mcp-serve coordinator --check --json` still reports the coordinator server and tool list, and focused MCP tests pass without provider credentials.
3. **RPC stdio:** at least one stdio or client contract test proves JSONL startup/command routing without a real provider key.
4. **ACP mode:** initialize/stdout or conformance tests prove the ACP JSON-RPC entrypoint and capability advertisement without a real provider key.
5. **Bridge HTTPS:** bridge auth/handler tests prove TLS requirement, authenticated handshake, help/health behavior, and default `endpoint_disabled` session-control posture.
6. **Local leak audit:** deliverable docs/tests must not contain private profile names, user-home paths, callback artifact paths, local proxy names, terminal app names, or private launch wrappers.

Optional live smokes are useful diagnostics for one operator's model/profile/network setup, but they must not be required for PR readiness unless the PR explicitly changes live provider behavior.
