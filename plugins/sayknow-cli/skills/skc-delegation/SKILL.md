---
name: skc-delegation
description: Delegate planning, execution, and team workflows to sayknow-cli via the coordinator MCP server.
---

# SKC delegation

This plugin exposes sayknow-cli's coordinator MCP server so a host agent can
delegate whole workflows to SKC and receive durable turn status plus artifacts.

## Tools

| Tool | Workflow | SKC skill | Purpose |
| --- | --- | --- | --- |
| `skc_delegate_plan` | plan | /skill:ralplan | Delegate consensus planning to SKC (runs /skill:ralplan to a pending-approval plan). |
| `skc_delegate_execute` | execute | /skill:ultragoal | Delegate execution to SKC (runs /skill:ultragoal to completion with verification). |
| `skc_delegate_team` | team | /skill:team | Delegate parallel team execution to SKC (runs /skill:team with internal tmux workers). |

## Fail-closed safety

The bundled MCP config sets `SKC_COORDINATOR_MCP_WORKDIR_ROOTS` to the host
project directory and does **not** set `SKC_COORDINATOR_MCP_MUTATIONS`.
Delegation is read-only until the user explicitly enables a mutation class and
passes `allow_mutation: true` per call. `SKC_COORDINATOR_MCP_REPO` is a
namespace label only, never a filesystem path.

## Polling

Each delegate returns a `turn_id`. Poll `skc_coordinator_await_turn` (bounded)
or `skc_coordinator_watch_events` for the `delegation.started` event and the
terminal turn state. Turn state is the source of truth, not terminal scrollback.
