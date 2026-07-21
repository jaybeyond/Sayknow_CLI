# Coordinator MCP bridge

SKC exposes a native outward MCP bridge for external coordinators:

```bash
skc mcp-serve coordinator
```

`skc mcp-serve hermes` is accepted as a compatibility alias for the same coordinator bridge.

The bridge is intentionally separate from SKC's client-side MCP runtime. It lets an external coordinator discover and control SDK-backed sessions, queue bounded follow-up prompts, read status/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Core contract and adapters

The coordinator bridge is intentionally a core contract with multiple adapters, not an MCP-only or Hermes-only product direction. Hermes is one compatibility preset, not a privileged integration mode:

- `packages/coding-agent/src/coordinator/contract.ts` owns transport-neutral server metadata and tool names.
- `skc mcp-serve coordinator` is the outward MCP adapter for external agents.
- `skc coordinator` is the read-only CLI/debug adapter for humans and scripts that need to inspect the same contract without starting MCP transport.
- `skc setup hermes` is the compatibility setup adapter that renders coordinator config and operator guidance.

Future session, turn, question, artifact, and report behavior should move toward shared coordinator core services that both MCP and CLI adapters call instead of duplicating transport-specific logic.

## Coordinator setup adapter

Use `skc setup hermes` to render or install a portable MCP setup package for any controller that accepts Hermes-compatible MCP config:

```bash
skc setup hermes --root /path/to/repo --profile my-bot --repo sayknow-cli
```

The default mode is render-only and writes no files. To install into a Hermes profile:

```bash
skc setup hermes \
  --root /path/to/repo \
  --profile my-bot \
  --repo sayknow-cli \
  --mutation sessions,questions,reports \
  --profile-dir /path/to/hermes/profile \
  --install
```

The generated setup is model-agnostic and worktree-isolated. By default it renders `SKC_COORDINATOR_MCP_SESSION_COMMAND` as `skc --worktree`, which is a typed selector for SDK lifecycle creation—not a shell command the bridge runs. Spawned sessions launch inside a SKC-managed sibling worktree while SKC retains the source repository as project identity. Users who need a stable named branch can set `--worktree-name`:

```bash
skc setup hermes \
  --root /path/to/repo \
  --worktree-name hermes-sayknow-cli
```

The runtime accepts only the literal selectors `skc` and `skc --worktree [name]`. It rejects local wrappers, shell syntax, tmux flags, and model/provider flags before creating a session. Existing setup configs that contain a legacy explicit `--session-command` must be changed to one of those selectors; provider and model resolution remains normal SKC configuration, not coordinator command injection.

Run a non-mutating setup smoke check with:

```bash
skc setup hermes --root /path/to/repo --smoke
```

Smoke verifies the MCP server/tool contract. It does not call a downstream LLM and does not validate provider credentials.


## Safety model

The bridge is read-only and fail-closed by default.

Required root allowlist:

```bash
export SKC_COORDINATOR_MCP_WORKDIR_ROOTS="/path/to/repo:/path/to/worktrees"
```

Mutating tools require both startup opt-in and per-call consent:

```bash
export SKC_COORDINATOR_MCP_MUTATIONS="sessions,questions,reports"
```

Every mutating MCP call that requires a caller key must include `allow_mutation: true` and the required caller-provided `idempotency_key`. The bridge durably binds the key to the tool and canonical arguments, serializes concurrent duplicates, replays the original bounded public response, and rejects reuse with different arguments as `idempotency_conflict`.

`skc_coordinator_start_session` uses SDK lifecycle control with the configured typed SKC selector. `skc setup hermes` writes `skc --worktree` by default:

```bash
export SKC_COORDINATOR_MCP_SESSION_COMMAND="skc --worktree"
```

The only supported values are `skc` and `skc --worktree [name]`; this variable is never evaluated as a shell command. The coordinator binds registration, reuse, and control to the broker's exact canonical workspace and endpoint generation, then discovers the generation-bound SDK endpoint internally. Endpoint credentials are never persisted in coordinator records or returned by coordinator tools. `skc_coordinator_read_coordination_status` returns a canonical polling snapshot for public session, state, turn, question, report, and bounded event data. Tmux identifiers, when supplied while registering an existing session, are advisory process metadata only; they do not provide control authority, machine viewing, startup, prompt injection, or determine turn completion.

For resume safety, prefer the generated SKC-native worktree selector over creating a git worktree in Hermes itself. SKC's launch path records the original repo as the project identity while running in the worktree, so session listing/resume can still group the session under the source project. If Hermes creates and later deletes an unmanaged worktree, a saved session may still exist but its cwd can be gone.

Artifact reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `SKC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP`.

`skc setup hermes` renders `SKC_COORDINATOR_MCP_WORKDIR_ROOTS` with the host platform path delimiter (`:` on POSIX, `;` on Windows). Manual configs should prefer the same encoding.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export SKC_COORDINATOR_MCP_PROFILE="team-a"
export SKC_COORDINATOR_MCP_REPO="sayknow-cli"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `skc_coordinator_list_sessions`
- `skc_coordinator_read_status`
- `skc_coordinator_read_tail`
- `skc_coordinator_list_questions`
- `skc_coordinator_list_artifacts`
- `skc_coordinator_read_artifact`
- `skc_coordinator_read_coordination_status`
- `skc_coordinator_read_turn`
- `skc_coordinator_await_turn`
- `skc_coordinator_watch_events`


Mutating tools:

- `skc_coordinator_start_session`
- `skc_coordinator_register_session`
- `skc_coordinator_send_prompt`
- `skc_coordinator_submit_question_answer`
- `skc_coordinator_report_status`
- `skc_delegate_plan`
- `skc_delegate_execute`
- `skc_delegate_team`

The `skc_delegate_*` tools are high-level, session-level delegation: each starts (or reuses) an SDK-discovered session and sends one workflow-tagged turn for `/skill:ralplan`, `/skill:ultragoal`, or `/skill:team`, returning a durable `turn_id`, status, and artifact references. They use the same `sessions` mutation class and fail-closed workdir gating as `skc_coordinator_start_session`, and emit a `delegation.started` event. Pass `await_completion: true` to use the durable bounded await/report path; `timeout_ms` and `poll_interval_ms` apply to that completion payload. Without it, the tool returns immediately after SDK acknowledgement. Pass `cwd` and `task`; set `allow_mutation: true` and a caller-provided `idempotency_key` only with startup mutation opt-in plus per-call consent. Optionally pass `mpreset` (same semantics as `skc --mpreset <profile>`) to `skc_coordinator_start_session` or a delegate tool to authoritatively activate a SKC model profile when starting a fresh session — it is resolved through the merged built-in/custom profile registry, applied from the first turn, and surfaced in status; unknown names are rejected with the available-profile listing, and reusing a session with a conflicting `mpreset` fails with `mpreset_conflict`. This is distinct from the advisory `model` prompt hint. Prefer these over manual `start_session` + `send_prompt` when delegating a whole workflow.

`skc_coordinator_register_session` registers an existing SDK-discoverable SKC session for coordinator control. It validates the workdir allowlist and session id, then verifies the broker's exact canonical workspace and endpoint generation before writing a credential-free session record. Optional tmux identifiers are retained only as advisory process metadata and are never machine-read.
## Turn orchestration flow

External coordinators should treat turns, not terminal scrollback, as the unit of work:

1. Call `skc_coordinator_start_session` with `allow_mutation: true` and `idempotency_key`.
2. Call `skc_coordinator_send_prompt` with `allow_mutation: true` and `idempotency_key`.
3. Store the returned `turn_id`.
4. Poll `skc_coordinator_read_turn`, or call bounded `skc_coordinator_await_turn`, until the turn is terminal.
5. Pull `skc_coordinator_list_questions` with the required `session_id`; it reconciles pending `workflow.gates.list` rows and returns bounded questions, diagnostics, and reconciliation state. Submit each pending row with `skc_coordinator_submit_question_answer`.

6. Use `skc_coordinator_report_status` with `session_id` and `turn_id` to write explicit completion/failure evidence.
   Use `status: "cancelled"` for coordinator-policy cancellation, and `status: "failed"` plus `blocker` for provider/tool/task failures.

`skc_coordinator_send_prompt` returns versioned top-level routing fields that exactly mirror its nested durable `turn`: `status`, `queued`, and `delivered` equal `turn.status`, `turn.delivery.queued`, and `turn.delivery.delivered`; `active_turn_id` is the new turn id unless this response queued a follow-up, in which case it is the existing active turn id.

```json
{
  "ok": true,
  "session_id": "skc-coordinator-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "active_turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "status": "active",
  "queued": false,
  "delivered": true
}
```

A session may have only one active turn by default. A second prompt is rejected with `active_turn_exists` unless the caller explicitly passes `queue: true` or `force: true`. Queued turns are durable and the next queued turn is promoted when the active turn reaches a terminal `skc_coordinator_report_status`. Force supersedes the previous active turn and audits that state in the turn journal.
Coordinator cancellation is recorded through `skc_coordinator_report_status` with terminal `status: "cancelled"`; this updates durable turn state but does not control any process. If the correct policy is replacement work rather than cancellation, send the replacement prompt with `force: true` so the previous active turn is superseded and audited.

`skc_coordinator_read_turn` returns the authoritative durable turn and SDK-only advisory status. For the latest assistant output, use `skc_coordinator_read_tail`; it queries `session.last_assistant` through the session SDK and returns only the requested bounded line suffix, never terminal output.

```json
{
  "ok": true,
  "turn": {
    "schema_version": 1,
    "turn_id": "turn-00000000-0000-0000-0000-000000000000",
    "session_id": "skc-coordinator-demo",
    "status": "completed",
    "final_response": {
      "text": "Done",
      "format": "markdown",
      "source": "report_status",
      "artifact_path": null,
      "truncated": false
    },
    "evidence": [{ "path": "artifact.txt" }],
    "error": null
  },
  "advisory_status": {
    "authority": "sdk",
    "live": true,
    "is_streaming": false
  }
}
```

The coordinator MCP bridge is currently a durable polling/await surface. It does not expose a push subscription stream; external coordinators should poll `skc_coordinator_read_coordination_status`, `skc_coordinator_read_turn`, or bounded `skc_coordinator_await_turn` instead of waiting for server-sent push events.

External `session_id`, `turn_id`, and `question_id` values are validated before path use, and loaded records must match the requested session/turn owner.

### Coordinator question pull loop

`skc_coordinator_list_questions` requires `session_id` and reconciles the session's pending `workflow.gates.list` rows on every call. Its bounded response contains public `questions`, `diagnostics`, and `reconciliation`; `status: "pending"` selects pending rows, while `status: "open"` remains a compatibility alias. More than one pending question may be returned. Public rows expose only the safe question shape, public option ids, and a fresh `answer_binding` for each pending row—never raw/private gate payloads or values.

`skc_coordinator_submit_question_answer` requires `session_id`, `turn_id`, `question_id`, `answer_binding`, `answer`, `idempotency_key`, and `allow_mutation: true`. Copy the identifiers and binding from the pending row and use the advertised answer shape. The bridge re-reconciles and revalidates ownership, pending state, and the binding before calling `workflow.gate_answer`; it never invokes generic `ask.answer`. An incomplete snapshot fails as `terminal_uncertain`; stale, terminal, missing, or ownership-mismatched rows are non-answerable. Restart can remint or quarantine gates, so re-list instead of reusing old rows. Identical idempotent replay returns the original accepted result; the same key with different arguments fails `idempotency_conflict`.

This pull-loop contract is independent of #2549/#2551 and unattended plain-CLI handling.

## Coordinator event journal

The bridge persists a restart-safe event journal under the configured coordinator state namespace, for example:

```text
$SKC_COORDINATOR_MCP_STATE_ROOT/<profile>/<repo>/events/event-journal.jsonl
```

Each event is a bounded JSONL record with `schema_version`, monotonic namespace-local `seq`, stable `id`, `timestamp`, canonical `kind`, optional `session_id`/`turn_id`/`question_id`/`report_id`, short `summary`, optional `payload_ref`, and bounded scalar `metadata`. Full prompts, reports, final responses, and artifacts stay in their existing turn/report/artifact read paths; event records only point at them.

`skc_coordinator_watch_events` is a bounded long-poll MCP tool, not an unbounded stream. Inputs are `after_seq` (default `0`), optional `session_id`, optional `event_types`, `timeout_ms` capped at 30000, and `limit` capped at 100. If matching events already exist after `after_seq`, it returns immediately. Otherwise it waits for the event journal to change or for timeout. The response includes `events`, `latest_seq`, `timed_out`, and `transport: { "mcp": "long_poll", "push_subscriptions": false }`, so coordinators can persist `latest_seq` and resume safely after restart.

`skc_coordinator_read_coordination_status` keeps its existing report fields and now also includes `latest_event_seq` plus recent event summaries for snapshot-style consumers.

## Generic controller config snippet

```json
{
  "mcp_servers": {
    "skc_coordinator": {
      "command": "skc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "SKC_COORDINATOR_MCP_WORKDIR_ROOTS": "/path/to/repo",
        "SKC_COORDINATOR_MCP_PROFILE": "team-a",
        "SKC_COORDINATOR_MCP_REPO": "project",
        "SKC_COORDINATOR_MCP_SESSION_COMMAND": "skc --worktree"
      },
      "enabled": true
    }
  }
}
```

## Smoke check

```bash
skc mcp-serve coordinator --check --json
```

Expected result includes `ok: true`, server name `skc-coordinator-mcp`, and the SKC-named tool list. The JSON check is discovery-only and non-mutating: it retains those legacy fields and adds `catalog: { "ready": true, "reason": null }` and `broker`. `broker.discovery_status` is `ready`, `unavailable`, or `error`, with reason `null`, `absent_or_invalid`, `unsupported_state_version`, `discovery_access_denied`, or `discovery_read_failed`. `broker.operational_ready` is always `null`; the check does not connect, ensure/bootstrap, write, repair, or delete. `bootstrap_supported` is `true` and `bootstrap_attempted` is `false`. It does not expose broker authority, path, endpoint, process metadata, token, or raw error details. `skc mcp-serve hermes --check --json` returns the identical coordinator check payload; its human output remains the server/tools summary.
