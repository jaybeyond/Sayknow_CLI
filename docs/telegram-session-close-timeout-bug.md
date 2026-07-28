# Telegram `/session_close` uncertain outcome and delayed topic cleanup

## Baseline

- Branch: `fix/telegram-session-close-timeout`
- Base: `upstream/dev` at `12aa7ebd18752c338b55a6ddc0ca8945f6e555cb`
- Reported: 2026-07-22

## Reproduction

1. Create a SKC session from Telegram and wait until its topic/session is active.
2. Send:

```text
/session_close <sessionID>
```

3. Observe the close response, process/session liveness, and Telegram topic lifecycle.

## Expected behavior

- A valid managed session ID is resolved deterministically.
- The close request terminates the target session promptly.
- The daemon returns one clear terminal close result.
- The Telegram topic/thread is deleted promptly after the session reaches the terminal state.
- A timeout is reserved for a genuinely unresponsive close operation, not the normal successful path.

## Observed behavior

- Telegram displays `Close outcome uncertain. The session may already be closed — check /session_recent before retrying.`
- The target process appears to terminate, but the close request does not receive authoritative terminal confirmation.
- The Telegram topic remains visible for approximately 60 seconds.
- The topic is then deleted by the orphan-topic cleanup path after `ORPHAN_TOPIC_GRACE_MS`, rather than promptly by the authenticated `session_closed` handler.

The warning does not mean the session is confirmed closed. It means the close effect may have occurred, but the daemon could not prove the terminal result. The delayed deletion indicates that normal terminal cleanup was missed and the 60-second orphan fallback recovered it later.

## Investigation focus

Trace one lifecycle request ID across:

- Telegram command parsing and acknowledgement
- `session_close` lifecycle frame dispatch
- managed tmux/session identity resolution
- force-close SIGTERM, owner-verdict, and compatibility cleanup ordering
- owner/supervisor terminal-state observation
- close outcome generation
- Telegram topic deletion

Pay particular attention to ordering. The managed owner must publish its immutable terminal verdict before runtime-state serialization, coordinator/state-file locks, and terminal-payload preservation can delay or return from postmortem handling. Topic cleanup remains an independent path: it must follow an authenticated `session_closed` frame for the current endpoint generation and lease, never a lifecycle acknowledgement alone. Also verify that the supplied session ID maps to the actual managed tmux name and generation.

## Regression coverage

Add focused tests for:

1. A live managed session closes before the timeout and emits one terminal outcome.
2. Topic deletion occurs after terminal close evidence, without waiting for the timeout.
3. A session that exits during the close race is treated idempotently as closed.
4. Repeating the same close request returns the prior terminal result without another timeout.
5. Unknown and unmanaged session IDs fail closed without deleting unrelated topics.
6. A genuinely stuck process reaches the bounded force-close path and reports that distinct outcome.

## Acceptance criteria

- `/session_close <sessionID>` makes the managed session non-live promptly under normal conditions.
- The normal path does not display an intermediate outcome that remains pending until timeout.
- Topic deletion is prompt, deterministic, and tied to the correct session generation.
- Timeout/force-close remains bounded and observable for genuinely unresponsive sessions.
- Close remains replay-safe and cannot kill a reused tmux session belonging to another generation.
