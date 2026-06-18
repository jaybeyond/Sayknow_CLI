# 10 — No session registry to discover/enumerate/reattach running RPC sessions

- **Severity:** High (missing capability)
- **Scope:** `python/skc-rpc/src/skc_rpc/client.py` (no discovery API) + a new shared registry module under `.skc/` state; relates to `packages/coding-agent/src/modes/rpc/rpc-mode.ts` and `packages/coding-agent/src/modes/bridge/bridge-mode.ts`
- **Surface:** RPC control plane / multi-session management

## Summary

There is no cross-process registry of running skc RPC sessions. A host cannot
ask "what sessions are alive, and how do I reach them?":

- **RPC (stdio) mode** has no addressable endpoint at all — the session only
  exists for the lifetime of the pipe (issue 09).
- **Bridge (HTTP) mode** is addressable (`/v1/sessions/{sessionId}/…`) but a
  client must already know the **host, port, `sessionId`, and token** out of
  band. Nothing enumerates live bridge servers or their session ids.
- The only "registry" in the codebase is `SessionObserverRegistry`
  (`packages/coding-agent/src/modes/interactive-mode.ts`), which is an
  **in-process** TUI construct for observing subagents — not a cross-process
  discovery mechanism.
- `skc session` exists but manages **tmux** sessions, not RPC/agent sessions.

So persistent sessions (issue 09) are not even useful without a way to find them
after the launching client is gone.

## Impact

- No `list` / `attach` / `reattach` story for RPC hosts. Reconnecting after a
  host restart is impossible because the endpoint/identity is unknown.
- No way to enforce single-writer / claim semantics across clients, observe an
  unattended run from a second tool, or build a supervisor that reaps dead
  sessions.

## Suggested fix (direction)

Introduce a lightweight session registry the control plane writes to and clients
read from:

- On session start in a persistent mode, register a record under the SKC state
  dir (e.g. `~/.skc/agent/rpc-sessions/<sessionId>.json`) containing
  `{ sessionId, pid, transport (socket path / host:port), token-ref, cwd, model,
  startedAt, status }`, and remove/mark it on shutdown (with stale-PID reaping).
- Expose discovery in `skc_rpc`:
  ```python
  RpcClient.list_sessions() -> tuple[SessionHandle, ...]
  RpcClient.attach(session_id | endpoint) -> RpcClient
  ```
- Optionally surface a `skc rpc sessions` CLI to list/inspect/kill, mirroring the
  existing `skc session` (tmux) UX but for agent RPC sessions.

This is the companion to issue 09: persistence provides the durable session, the
registry provides discovery + reattach.
