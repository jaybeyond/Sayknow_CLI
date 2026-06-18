# 09 — No persistent/detached RPC session; `skc_rpc` runs a foreground child that dies with the client

- **Severity:** High (missing capability)
- **Scope:** `packages/coding-agent/src/modes/rpc/rpc-mode.ts:526-581` (stdin-EOF shutdown), `python/skc-rpc/src/skc_rpc/client.py:404-492` (foreground `Popen` + `stop`)
- **Surface:** RPC session lifecycle / transport

## Summary

There is no way to run a **persistent** skc RPC session that outlives the client
connection. Two facts combine to bind a session's lifetime to a single foreground
pipe:

1. **Server exits on stdin EOF.** `runRpcMode` reads stdin as JSONL and, when the
   stream closes, calls `shutdown(0, "RPC client disconnected")` →
   `process.exit(0)`:
   ```ts
   // rpc-mode.ts
   for await (const line of readLines(Bun.stdin.stream())) { … }
   await shutdown(0, "RPC client disconnected"); // stdin closed -> process exits
   ```
2. **Client owns the process as a foreground child.** `skc_rpc` spawns
   `subprocess.Popen(...)` and `stop()`/`__exit__` closes stdin and
   terminates/kills it:
   ```python
   # client.py
   process = subprocess.Popen(list(self._build_command()), …)   # foreground child
   # stop():
   process.stdin.close(); process.terminate(); process.kill()
   ```

So the moment the Python host disconnects (context-manager exit, crash, or
network blip in a wrapping service), the agent session is torn down. There is no
daemon mode, no detached server, and no reattach.

A persistent HTTP transport (`--mode bridge`, `Bun.serve` on port 4077 with
`/v1/sessions/{id}/…` endpoints + `control:claim`/`control:disconnect`) already
exists and demonstrates the building blocks (a session that survives a client
disconnect, owner-token control hand-off). But it is a **separate surface that
`skc_rpc` does not use**, and it is still one session per launched process.

## Impact

- Long-running orchestration hosts cannot restart/redeploy without killing every
  in-flight agent session.
- No "start a session now, attach a UI/observer later" workflow.
- Combined with issue 04, even brief disconnect/reconnect churn is destructive.

## Suggested fix (direction)

Add a persistent/detached session mode for `skc_rpc`:

- A `skc rpc serve` (detached) variant that keeps the `AgentSession` alive
  independent of any single client connection — reuse the bridge transport
  (local socket or `Bun.serve`) instead of stdin-EOF teardown.
- In `skc_rpc`, default to **attach-to-persistent** rather than spawn-foreground:
  - `RpcClient.connect(endpoint)` attaches to an already-running session over the
    persistent transport;
  - keep `spawn` as an explicit opt-in for ephemeral one-shot use;
  - on client `stop()`, **detach** (leave the session running) by default rather
    than terminate.
- Pairs with issue 10 (a registry so clients can find the endpoint to attach to).
