# cron

> A single inline tool that schedules recurring or one-shot prompts within the current session. Select the operation with the `op` field (`create` | `list` | `delete`).
>
> **Note on upstream parity:** upstream Claude Code exposes three sibling tools (`CronCreate`, `CronList`, `CronDelete`). SKC intentionally consolidates them into one `cron` tool with an `op` discriminator (matching the `op`/`action` pattern used by `job`, `subagent`, `goal`, and `irc`). The frozen upstream schema fixtures are retained as a historical record; see "Parity oracle" below.

## Source

- Entry: `packages/coding-agent/src/tools/cron.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron.md`
- Key collaborators:
  - `packages/coding-agent/src/async/job-manager.ts` — provides the `registerOwnerCleanup` / `runOwnerCleanups` primitives that clear schedules on session/agent teardown.
  - `packages/coding-agent/src/session/agent-session.ts` — invokes `runOwnerCleanups({ ownerId })` from `#cancelOwnAsyncJobs()` before cancelling owned jobs, so cron timers cannot race teardown.

## Operations

| `op` | Purpose |
| --- | --- |
| `create` | Schedule a prompt on a 5-field cron expression. Returns an 8-character job id. |
| `list` | List every scheduled task in this session (per calling agent). |
| `delete` | Cancel a scheduled task by id. |

Each session can hold up to **50** scheduled tasks per owner. Recurring tasks
auto-expire **7 days** after creation. One-shot tasks delete themselves after
firing.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"create" \| "list" \| "delete"` | Yes | Selects the operation. |
| `cron_expression` | `string` | `op=create` | Standard 5-field cron expression in local time: `minute hour day-of-month month day-of-week`. |
| `prompt` | `string` | `op=create` | Prompt to inject between turns when the cron fires. |
| `recurring` | `boolean` | `op=create` (defaults `true`) | `true` to fire on every match (recurring, auto-expires after 7 days); `false` to fire once and self-delete. |
| `id` | `string` | `op=delete` | The 8-character job ID returned by `op=create`. |

Supported field syntax: `*`, single values (`5`), steps (`*/15`), ranges
(`1-5`), comma lists (`1,15,30`). Day-of-week uses `0`/`7` for Sunday through
`6` for Saturday. Extended syntax such as `L`, `W`, `?`, or weekday/month
name aliases is **not** supported and the tool will reject expressions that use
them.

## Outputs

- `op=create` content: `Scheduled <id> (<human-schedule>)`. `details`: `{ op: "create", id, cron_expression, recurring, nextFireAt }`.
- `op=list` content: lines of `<id> (<human-schedule>): <prompt preview>`, or `No scheduled jobs` when empty. `details`: `{ op: "list", jobs }` where `jobs` is an array of `{ id, cron, recurring, prompt, humanSchedule }`.
- `op=delete` content: `Cancelled <id>` on success, `No scheduled task '<id>' found; nothing to cancel.` otherwise. `details`: `{ op: "delete", id, deleted }`.

## Behavior / Lifecycle

1. The cron tool gates on `isBackgroundJobSupportEnabled(session.settings)`. When async is disabled, the cron tool is not registered in `BUILTIN_TOOLS`.
2. Schedules are stored in-memory per `ownerId` (resolved via `session.getAgentId()`). Subagents have their own isolated schedule lists.
3. The first `op=create` call for a new owner registers an owner cleanup with `AsyncJobManager.registerOwnerCleanup(ownerId, fn)`. The cleanup clears every schedule for that owner and is run by:
   - `AgentSession.#cancelOwnAsyncJobs()` on dispose / new-session / session-switch / handoff / branch
   - `AsyncJobManager.dispose()` as a run-and-clear safety net
4. Cron expression validation rejects malformed input synchronously with a `ToolError` whose message names the offending field.
5. Each task is backed by a `setTimeout` for the next jitter-adjusted match. One-shot tasks self-delete after firing; recurring tasks reschedule until the 7-day expiry timer deletes them.
6. The per-owner 50-task cap is enforced on `op=create`; the caller receives a `ToolError` rather than a silent drop.

## Errors

- `ToolError`: `Async execution is disabled; cron is unavailable in this session.`
- `ToolError`: `cron op=create requires both 'cron_expression' and 'prompt'.`
- `ToolError`: `cron op=delete requires 'id'.`
- `ToolError`: `Invalid cron expression: ...` (field count, range, step value, ordering)
- `ToolError`: `Cron task limit reached (50). Cancel an existing task with cron op=delete first.`
- `ToolError`: `Cron is disabled by CLAUDE_CODE_DISABLE_CRON=1.`
- zod validation errors for missing or wrong-typed inputs.

## Examples

Schedule a 5-minute deployment poll:

```jsonc
{
  "op": "create",
  "cron_expression": "*/5 * * * *",
  "prompt": "Check whether the staging deployment finished and tell me what happened",
  "recurring": true
}
```

One-shot reminder at 9am local:

```jsonc
{
  "op": "create",
  "cron_expression": "0 9 * * *",
  "prompt": "Remind me to push the release branch",
  "recurring": false
}
```

List scheduled tasks, then cancel one:

```jsonc
{ "op": "list" }
```

```jsonc
{ "op": "delete", "id": "ab12cd34" }
```

## Parity oracle

The upstream Claude Code per-tool schemas remain frozen as a historical record under
`packages/coding-agent/test/fixtures/claude-code-tools/`:

- `cron-create.schema.json`
- `cron-list.schema.json`
- `cron-delete.schema.json`

These fixtures were captured from the upstream Claude Code CLI (`claude --version 2.1.152`)
and document the upstream three-tool surface. SKC's consolidated `cron` tool intentionally
diverges from that surface; the fixtures and `claude-code-tools-fixtures.test.ts` validate
the frozen upstream records, not SKC's live tool shape.
