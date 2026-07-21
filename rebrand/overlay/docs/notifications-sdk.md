# Notifications SDK

<p align="center">
  <img src="../assets/telegram-mobile-hero.png" alt="Sayknow-CLI mobile answers for coding agents hero illustration" width="100%" />
</p>

A small, transport-agnostic way to get **action-needed** signals out of a SKC
session and deliver **replies** back — without scraping the terminal and without
the depth of the RPC / Coordinator / Bridge surfaces.

The stable contract is deliberately generic: every running session exposes one
loopback WebSocket endpoint, and integrations are user-written clients that
connect to that endpoint. Telegram, Discord, Slack, mobile apps, and local tools
all use the same JSON protocol. No upstream Rust, N-API, or wire-protocol change
is required for a new integration.

> Status: the Rust core (`crates/skc-notifications`) provides the wire protocol,
> action lifecycle, loopback WebSocket server, and endpoint discovery file. The
> bundled Telegram daemon is a reference client layered on top of this SDK; it is
> not the upstream topology.

## Architecture

```
SKC session (upstream)                          your client (anywhere)
┌───────────────────────────────┐               ┌──────────────────────────┐
│ ask-tool fires / agent idle    │  action_needed │ Telegram / Discord / ... │
│   → notifications core         │ ─────────────▶ │  render + collect reply  │
│ ws://127.0.0.1:<port> (+token) │ ◀───────────── │                          │
│   reply → resolve ask gate     │     reply       │                          │
└───────────────────────────────┘               └──────────────────────────┘
```

- **One endpoint per session.** Each session runs its own loopback WebSocket
  server. Upstream does not maintain a shared daemon, singleton, or
  chat-to-session registry; multiplexing many sessions into one integration is a
  client-side concern.
- **Integrations are clients.** A client discovers endpoint files, connects to
  one or more WebSockets, renders `action_needed`, and sends `reply` messages.
- **Zero upstream change.** New transports do not require changes to
  `crates/skc-notifications` or the JSON protocol.
- **Off unless configured.** No endpoint exists unless notifications are enabled
  and a token is present.
- **tmux-agnostic.** The endpoint behaves identically with or without tmux.

### N-API action emission

`NotificationServer#pushFrame(frameJson)` rejects (throws for) every `ActionNeeded`
frame. Emit asks with `registerAsk(...)` and idle notifications with `noteIdle(...)`
instead, so action delivery remains capability-gated per connection.


## Endpoint discovery

A running session writes a discovery file at:

```
<repo>/.skc/state/notifications/<sessionId>.json
```

(`.skc/state/` is git-ignored.) Shape:

```json
{
  "version": 1,
  "sessionId": "019edd41-...",
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 53124,
  "url": "ws://127.0.0.1:53124",
  "token": "<per-session token>",
  "startedAt": 1718760000000,
  "updatedAt": 1718760000000,
  "stale": false
}
```

- The file is created `0700`/`0600` (unix) and written atomically.
- The **token is in the file** because clients need it; never log it raw.
  Stale files (dead PID, past TTL, or explicitly marked) are cleaned up on the
  next start.

Connect with the token as a query parameter:

```
ws://127.0.0.1:<port>/?token=<token>
```

A wrong/missing token is rejected at the handshake with HTTP `401`.

## Protocol

JSON text frames. Field names are `camelCase`; the `type` discriminator is
`snake_case`.

### Server → client

`action_needed` — something needs attention:

```json
{ "type": "action_needed", "id": "wg_run_stage_1", "kind": "ask",
  "sessionId": "sess-1", "question": "Proceed?", "options": ["Yes", "No"] }
```

```json
{ "type": "action_needed", "id": "idle-sess-1-7", "kind": "idle",
  "sessionId": "sess-1", "summary": "finished refactor; awaiting next step" }
```

- `kind: "ask"` is answerable in both interactive/TUI and unattended/RPC modes.
  The `id` is the real workflow-gate id.
- `kind: "idle"` is notify-only and ephemeral (not replayed to clients that
  connect later).

`action_resolved` — a pending action is now terminal and **non-repliable**:

```json
{ "type": "action_resolved", "id": "wg_run_stage_1", "resolvedBy": "local" }
```

`resolvedBy` is `local` (answered in the CLI/TUI), `client` (a remote reply won),
or `timeout`.

`reply_rejected` — sent only to the client whose reply failed:

```json
{ "type": "reply_rejected", "id": "wg_run_stage_1", "reason": "already_answered" }
```

Reasons: `already_answered`, `unknown_action`, `invalid_answer`,
`resolver_unavailable`, `idempotency_conflict`, `unauthorized`.

`action_unavailable` — a controlled ask cannot be presented on this connection:

```json
{ "type": "action_unavailable", "id": "wg_run_stage_1", "sessionId": "sess-1",
  "reason": "missing_capability", "requiredCapabilities": ["ask_controls_v1"] }
```

This frame is diagnostic and non-actionable: do not render it as an ask or
attempt a `reply` for it.

The minimal contract depends on the asks a client handles. A client that handles
only ordinary asks (those with empty `controls`) needs `action_needed`,
`action_resolved`, and `reply_rejected`, and may omit `hello`. A client that
wants controlled asks **MUST** send a ClientHello on socket open with
`{ "type": "hello", "protocolVersion": 3, "capabilities": ["ask_controls_v1"] }`
and handle `action_unavailable` as a non-actionable diagnostic. Threaded clients
(like the managed Telegram daemon) may also receive optional server → client
frames they can render or ignore: `identity_header` (one-time per-session
repo/branch/machine header), `context_update` (last message, task, goal, token
usage, model, diff), `turn_stream` (live/finalized turn output),
`image_attachment` (agent-produced images), `activity` (busy/idle, drives the
typing indicator), `inbound_ack` (delivery state of an injected user message),
`session_closed` (endpoint teardown; threaded clients may delete/archive the
remote conversation), `config_update` (current verbosity/redact), `hello`
(server capability/version), and `pong`.

### Client → server

`reply` — answer a pending `ask`:

```json
{ "type": "reply", "id": "wg_run_stage_1", "answer": 0, "token": "<token>" }
```

`answer` accepts:

- a number — zero-based option index (`0` = first option);
- a string — an option label, or free text;
- an object — `{ "selected": [0, "Maybe"], "custom": "..." }` for multi-select;
- an object — `{ "controlId": "navigation_forward" }` to commit a controlled
  multi-select only when that navigation control was presented as enabled.

Optional `idempotencyKey` makes retries safe: the same key + same body re-acks;
the same key + different body is rejected with `idempotency_conflict`.

Clients may also send optional client → server frames: `user_message` (inject/steer
a turn with free text), `config_command` (toggle verbosity/redact in-thread),
`ping`, and `hello` (capability/version). A ClientHello is optional for ordinary
empty-controls asks, but is required for controlled asks as specified below.

## Answer semantics

A remote reply answers a pending ask in **both** modes — RPC is not required:

- **Interactive / TUI mode:** the ask tool races the local selector against the
  remote reply (first valid answer wins). If you tap a button in the client, the
  ask resolves with that option; if you answer locally, the client receives
  `action_resolved` (`resolvedBy: "local"`) and the action becomes non-repliable.
- **Unattended / RPC mode:** the reply resolves the real workflow-gate, driving
  the session the same way a local answer would.

In both modes the first valid reply wins; later replies get `already_answered`.
Idle pings are notify-only.

### Controlled-ask capability negotiation (protocol v3)

Protocol v3 adds optional `ask_controls_v1` and `ask_selected_ack_v1`
capabilities. A controlled ask carries both `options` and non-empty `controls`:

```json
{ "type": "action_needed", "id": "wg_run_stage_1", "kind": "ask",
  "sessionId": "sess-1", "question": "Choose all that apply",
  "options": ["A", "B"],
  "controls": [{ "id": "navigation_forward", "kind": "navigation", "label": "Done", "enabled": false }] }
```

Controls are typed data. Clients must return
`{"controlId":"navigation_forward"}` rather than infer a control from an
option label.

Clients that want controlled asks **MUST** send this ClientHello immediately in
their WebSocket `open` handler:

```json
{ "type": "hello", "protocolVersion": 3, "capabilities": ["ask_controls_v1"] }
```

The server sends its ServerHello before it processes a ClientHello. A controlled
ask is deferred while the connection awaits that Hello. After the approximately
one-second Hello grace expires, or after a negotiated Hello lacks
`ask_controls_v1`, the server sends exactly one non-actionable
`action_unavailable`; it never sends a stripped `action_needed` frame with option
buttons. A later ClientHello that adds `ask_controls_v1` may upgrade that
connection to the full `action_needed` presentation.

Capabilities are monotonic for one connection: repeated ClientHellos can add
capabilities but cannot remove an already-advertised capability or retract a
full presentation. Disconnecting and reconnecting starts a fresh negotiation
with no capabilities or delivery state. Ordinary asks with empty `controls`
retain their existing immediate delivery and reply behavior for Hello-less and
older clients.

### Protocol v3 semantic acknowledgement

A remote reply is first **claimed** by the native server. The host retains the raw reply JSON, idempotency key, and reply receipt id, then resolves or closes that claim only after ask/gate semantic settlement. Invalid input terminally closes that interaction; a retry is a fresh action id, never a reopened claim.

Managed Telegram clients may receive `ask_selected_ack_request` and return one correlated `ask_selected_ack_result`. Requests are `mode:"live"` (the current pending action on the authenticated session connection) or `mode:"recovery"` (the persisted session topic only). Recovery neither recreates an ask, keyboard, alias, nor reply route; a missing persisted topic is `failed/route_missing`. `ask_selected_ack_cancel` removes an exact queued request or aborts an in-flight attempt. The request/result/cancel correlation is `requestId` plus `commitKey` and is authorized by the authenticated WebSocket connection and endpoint generation; acknowledgement frames carry no second token.

The managed daemon sends the literal `Selected!` at most once per generation/commit key, on its `ask` rate-limit lane, with an absolute 8-second deadline and no application retry. A response is `delivered` only with Telegram `{ok:true,result.message_id:number}`; explicit rejection is `failed`, and timeout/network/in-flight abort uncertainty is `unknown`. Callback-query acknowledgement remains independent. The durable workflow answer is exactly-once; visible Telegram delivery is not.

Every accepted workflow-gate origin, including generic RPC/bridge winners, invokes canonical gate-presentation cleanup before continuation. Generic origins have no Telegram acknowledgement policy. Cancellation, shutdown, and endpoint replacement cancel retained interactions and acknowledgement work. A connection loss before dispatch is definitive `failed/session_closed`; after successful request-frame dispatch but before a correlated result it is `unknown/origin_disconnected`—the host does not infer whether Telegram was called.

## Minimal client example

This copyable example advertises `ask_controls_v1`, so it can receive and
complete controlled asks. An ordinary client that handles only empty-controls
asks omits the `open` handler and ClientHello, and keeps only the numeric
ordinary-ask branch below.

```js
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const { url, token } = JSON.parse(
  readFileSync(`.skc/state/notifications/${sessionId}.json`, "utf8"),
);

const ws = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
let currentControlledAsk;

function sendOptionReply(id, index) {
  ws.send(JSON.stringify({ type: "reply", id, answer: index, token }));
}

function commitControlledMultiSelect() {
  const ask = currentControlledAsk;
  const navigation = ask?.controls?.find(
    (control) =>
      control.id === "navigation_forward" &&
      control.kind === "navigation" &&
      control.enabled,
  );
  if (!navigation) return;

  ws.send(JSON.stringify({
    type: "reply",
    id: ask.id,
    answer: { controlId: "navigation_forward" },
    token,
  }));
}

ws.on("open", () => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "hello",
      protocolVersion: 3,
      capabilities: ["ask_controls_v1"],
    }));
  }
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "action_needed" && msg.kind === "ask") {
    if (msg.controls?.length) {
      currentControlledAsk = msg;
      // Present msg.question / msg.options / msg.controls to the human.
      // An option click calls sendOptionReply(msg.id, index). For a controlled
      // multi-select, that numeric reply only toggles and is non-terminal.
      // Wait for the fresh action_needed frame, then call
      // commitControlledMultiSelect() only from its enabled navigation control.
      return;
    }

    // Ordinary ask (`controls: []`): the minimal no-Hello client replies normally.
    sendOptionReply(msg.id, 0);
  } else if (msg.type === "action_resolved") {
    if (currentControlledAsk?.id === msg.id) currentControlledAsk = undefined;
    // Mark this action as no longer answerable in your UI.
  } else if (msg.type === "reply_rejected") {
    // e.g. reason === "already_answered" → the ask was answered elsewhere.
  } else if (msg.type === "action_unavailable") {
    // Diagnostic only: do not fabricate an ask or option buttons.
  }
});
```

`sendOptionReply(msg.id, index)` has the numeric option/toggle shape
`{ type:"reply", id, answer:index, token }`. The enabled navigation control
uses the distinct typed commit shape
`{ type:"reply", id, answer:{ controlId:"navigation_forward" }, token }`.
Do not send that commit against the pre-toggle action id: a multi-select option
toggle reissues the action, and the enabled navigation control on the latest
frame commits the selection.

Swap `ws` for a Telegram bot's long-poll loop, a Discord gateway client, or a
Slack socket-mode app — the contract above is all you implement.

## Managed notification adapters

For the exact user setup flow (`skc notify setup`, BotFather token, private-chat pairing, status, and troubleshooting), see [Telegram notification onboarding](./telegram-onboarding.md).

## Managed Telegram daemon (bundled reference client)

SKC also ships a managed Telegram reference client for the common phone-notify
workflow. It remains a client of the generic SDK: it scans session discovery
files, opens each session WebSocket, and routes Telegram replies back to the
matching endpoint.

The daemon/session engine is shared. Session discovery, WebSocket protocol,
redaction decisions, rate-limit pooling, reply routing, singleton ownership, and
lifecycle control are not reimplemented by each chat surface. Telegram, Discord,
and Slack adapters are thin presentation layers: they render internal notification
events into transport payloads and map transport interactions back to `{sessionId,
actionId,answer}` replies.

### Setup and auto-connect

Run the setup command once:

```sh
skc notify setup
```

The wizard validates the bot token with Telegram, verifies private-chat Threaded
Mode capability via `getMe.has_topics_enabled`, waits for a private DM to the bot,
and writes canonical global Settings under `config.yml` in the SKC agent
directory. It enables:

- `notifications.enabled`
- `notifications.telegram.botToken`
- `notifications.telegram.chatId`
- `notifications.redact` (optional; default false)
- `notifications.discord.botToken` / `notifications.discord.channelId` (optional Discord adapter)
- `notifications.slack.botToken` / `notifications.slack.channelId` (optional Slack adapter)

After setup, sessions auto-connect when notifications are enabled. Each session
still publishes its own loopback endpoint; the daemon is only the Telegram-side
multiplexer.

For Telegram forum topics, the daemon deletes the per-session topic when the local
notification endpoint shuts down, so it disappears from the topic list. A resumed
session creates a fresh topic before sending again. The bot must be allowed to
delete messages in that chat; without that permission, deletion is best-effort and
delivery continues.

Per-session topics are titled `{repo}/{branch} - {title}` by default (falling back
to `{repo}/{branch}`, then the session title, then `SKC <id>` when identity is
missing). Set `notifications.telegram.topics.nameTemplate` to reorder or reshape
that title — for example `"{title} · {repo}/{branch}"` puts the session title
first so concurrent sessions on the same checkout stay distinguishable in the
sidebar. The template supports the `{repo}`, `{branch}`, and `{title}`
placeholders; unknown placeholders are left verbatim. The template is applied
only when every placeholder it references has a value for that session — otherwise
the daemon falls back to the built-in composition, so provisional and identity-less
topics never render with dangling separators. Leaving the setting unset preserves
the default naming exactly.

### Singleton poller and trust model

Telegram `getUpdates` allows only one active long-poll owner per bot token. The
managed daemon enforces **one bot token = one getUpdates poller** with a local
lock/state file under the agent directory. New sessions attach to the existing
fresh daemon owner instead of starting another poller, preventing Telegram 409
conflicts.

The trust model is intentionally strict:

- setup pairs exactly one private Telegram chat;
- runtime accepts updates only from that paired chat id;
- groups, supergroups, channels, and unpaired users never receive session names,
  action ids, pending status, or configuration hints;
- daemon state stores a token fingerprint, not the raw bot token.

### Routing in private-chat topics

The paired private chat prefers per-session Telegram topics (Threaded Mode). The
daemon tags messages by session, stores compact callback aliases for inline
buttons, and routes replies back to the exact session/action. A forum-enabled
supergroup is no longer required: when the bot owner enables Threaded Mode in
@BotFather, the daemon creates one topic per session in the paired private chat.
SKC cannot enable Threaded Mode through the Bot API; setup only verifies the
capability and guides the manual BotFather toggle.

If BotFather's per-bot **Bot Settings** menu does not show **Threads Settings**
or **Threaded Mode**, the supported fallback is the normal private-chat pairing.
Setup can be saved as `threaded=unverified`/`threaded=unknown`, and the daemon
still tries topics when Telegram allows them. When `createForumTopic` is refused,
the daemon does not drop the send: it routes the notification to the normal
(flat) paired private chat and posts a one-time nudge: `Flat Telegram private chat
supports outbound notifications and inline ask buttons only. Enable Threaded Mode
in @BotFather > Bot Settings > Threads Settings for free-text replies and session
commands.` Pairing is private-only, so flat delivery stays within the user's own
private DM.

Supported reply paths:

- tap an inline button on an ask notification;
- reply inside the session's thread/topic (replies are thread-native; the
  topic identifies the session, so no session tag is needed).

In threaded mode the user can also adjust per-session behaviour with in-thread
config commands: `/verbose`, `/lean`, `/verbosity <lean|verbose>`, and
`/redact <on|off>`. The legacy `/answer <session-tag> <answer>` command is
removed — replies are routed by the topic they arrive in.

Flat fallback keeps outbound notifications and inline-button answers working, but
plain free-text never guesses from the global pending-ask set. Free-text replies
and `/verbose`/`/lean`/`/verbosity`/`/redact` commands are thread-native and
require Threaded Mode/topic routing. Enable Threaded Mode in @BotFather > Bot
Settings > Threads Settings when you need free-text replies or session commands.
Do not pair a group, supergroup, or channel to work around a missing BotFather
menu; the bundled setup flow is
private-chat only, and non-private chat ids remain fail-closed to avoid session
data leaks.

Unknown, expired, or restart-unvalidated callback aliases fail closed: the daemon
sends guidance and does not guess a target session or action.

### Discord and Slack setup

Discord and Slack use the same internal notification events and reply protocol as
Telegram. Store only runtime credentials in local SKC settings or environment;
never paste bot tokens, webhook URLs, transcripts, prompts, host paths, or raw logs
into docs, tests, issues, or PR comments.

Configuration keys:

```yaml
notifications:
  enabled: true
  discord:
    botToken: "<local Discord bot token>"
    channelId: "<Discord channel id>"
  slack:
    botToken: "<local Slack bot token>"
    channelId: "<Slack channel id>"
  redact: true
```

The bundled adapters intentionally render public-safe message bodies and return
route metadata only for pending internal actions. They do not own polling,
session scans, daemon locks, rate limits, or SDK lifecycle. Production transport
senders should consume the adapter payloads and keep all credential-bearing HTTP
or gateway details outside logged payloads.
### Redaction

`notifications.redact` strips sensitive content before remote delivery, but
**asks are exempt**: an ask is an interactive prompt the human must read and
answer remotely, so its `question` and `options` are always sent unredacted
(otherwise it would be unanswerable). When redaction is enabled, `idle`
summaries are removed and streamed content frames (`turn_stream`,
`context_update`, `image_attachment`) are suppressed at their emit sites. When
redaction is disabled, all content is delivered unchanged.

### Local `/notify`

Inside a SKC session, `/notify` controls the current session only:

- `/notify status` reports enabled/disabled state, daemon observation when known,
  and redaction state without printing secrets;
- `/notify off` disables the current session's notification endpoint and removes
  its discovery record without mutating global Settings;
- `/notify on` re-enables the current session when global setup is complete and
  `SKC_NOTIFICATIONS=0` is not forcing opt-out.

### Manual Telegram CLI is for debugging

`packages/coding-agent/src/notifications/telegram-cli.ts` remains as a manual
reference/debug client and template for other integrations. It is not the primary
Telegram UX.

```sh
bun run packages/coding-agent/src/notifications/telegram-cli.ts --bot-token "$BOT_TOKEN"
```

By default it refuses to start when a fresh managed daemon already owns the same
bot token for the same paired chat, because a second poller will cause Telegram
409 conflicts. Use `--force` only for deliberate debugging when you have stopped
or intentionally want to override the daemon guard.
## Two client surfaces: per-session vs daemon-owned lifecycle control

The SDK now exposes **two distinct surfaces**. Do not confuse them:

1. **Per-session notification clients (the normal, documented contract above).**
   A client discovers `<repo>/.skc/state/notifications/<sessionId>.json`, connects
   to that session's loopback WebSocket, and handles `action_needed`,
   `action_resolved`, `reply_rejected`, and the optional threaded frames. This is
   all an ordinary integration (Telegram, Discord, Slack, mobile, local tools)
   needs. It requires **zero** upstream changes.

2. **The daemon-owned session *lifecycle* control endpoint (privileged).**
   A separate, **session-independent**, loopback-only, authenticated control
   endpoint that accepts `session_create` / `session_close` / `session_resume`
   frames. It exists because creating a session cannot use a per-session socket
   (none exists before the session does). It is **not** part of the normal
   integration contract: ordinary clients never implement it. Only the bundled,
   trusted daemon (e.g. the managed Telegram daemon) speaks it.

### Lifecycle control endpoint

- **Discovery:** `<agentDir>/notifications/control.json` (daemon-owned, mode
  `0600`), distinct from per-session endpoint files. It carries only non-secret
  endpoint metadata (url/host/port/pid/owner). The control token is held **in
  memory** by the daemon (the sole client) and is **never** written to disk.
- **Auth:** loopback-only bind (a non-loopback bind is refused). The WebSocket
  upgrade requires `?token=<control-token>` (HTTP `401` otherwise), and every
  lifecycle frame's `token` is re-checked (`unauthorized` on mismatch). The Rust
  ingress authenticates and forwards; it never spawns or applies policy.
- **Frames:** `session_create` (target `existing_path` | `worktree` |
  `plain_dir`), `session_close` (hard-kill, history preserved, recoverable),
  `session_resume` (reattach if alive, else cold-restart from history); responses
  `session_create_response` / `session_close_response` / `session_resume_response`
  / `session_lifecycle_error`. The protocol also defines a replayable
  `session_ready` per-session frame for readiness-gated creates; the current MVP
  daemon replies once the tmux launch is requested (see the phone guide) rather
  than waiting on it. Inline prompt text (`-- <prompt>`) is rejected in the MVP.

### Trust model and hardening (daemon side)

The control endpoint trusts the configured paired chat for any path (an accepted
risk). It is hardened around that boundary:

- **Strict paired-chat gating** — non-paired chats are rejected *before* any path
  parsing, filesystem, or process action.
- **Durable idempotency** — a locked, atomic, fsynced ledger keyed by
  `chatId:updateId` + request hash (`telegram-lifecycle-idempotency.json`).
  Duplicate updates never repeat side effects, including across daemon restart; a
  duplicate while in-progress reports pending (never a second spawn); a same id
  with a different body is `duplicate_conflict`; an effect failure is recorded
  `terminal_uncertain` (never auto-respawned).
- **Per-chat create rate limit.**
- **Audit log** — append-only `telegram-lifecycle-audit.jsonl` (`0600`) recording
  every accept/reject/duplicate/rate-limit/spawn/success/failure. Raw control
  tokens and raw prompts are never logged (prompt hash + byte length only).
- **Inline prompts rejected (MVP)** — `session_create` with `-- <prompt>` text is
  rejected with usage; no prompt is ever placed in argv, audit, or responses. (A
  redacted prompt-ref flow is reserved for a future revision.)
- **SKC-managed-only close** — force-close re-reads the exact `@skc-profile`
  immediately before kill and requires the `@skc-session-id` (and optional
  `@skc-session-state-file`) tag to match; it never touches non-SKC tmux.
- **Recent-activity picker** — sessions are ranked by history-file mtime and
  enriched with terminal breadcrumbs so the operator picks a recent repo/session
  instead of typing raw paths. Ambiguous resumes fail closed with candidates.
### Phone test guide (create / close / resume from Telegram)

End-to-end manual check once `skc notify setup` has paired your private chat:

1. **Pair + start.** Run `skc notify setup` (BotFather token, DM the bot to pair).
   Start any SKC session with notifications enabled so the daemon owner is
   running (`skc launch` in a repo, or `SKC_NOTIFICATIONS=1`). The owner starts
   the loopback control endpoint and accepts `/session_*` while running; with zero
   active sessions it still idle-exits after the inactivity timeout.
2. **Create.** From your paired chat, pick `/session_create` from the Telegram
   command menu or send `/session_create path <repo-dir>` (or
   `/session_create worktree <repo> <branch>`, or `/session_create dir <newdir>`).
   `<repo-dir>`, `<repo>`, and `<newdir>` may use `~`/`~/...` for your own home
   directory; named-user forms such as `~alice/repo` are rejected. The bot replies
   once the tmux launch is requested; the session shows up in `/session_recent`
   once it is ready. (Inline prompts via `-- <text>` are rejected for now with
   usage text.)
3. **List.** `/session_recent` shows recent sessions (most-recent first) to copy
   an id from.
4. **Close.** `/session_close <sessionId>` hard-kills the SKC-managed session
   (history is preserved); the bot confirms.
5. **Resume.** `/session_resume <sessionId|prefix>` reattaches if it is still
   alive, otherwise cold-restarts it from saved history. An ambiguous prefix
   replies with the matching candidates instead of guessing.

Commands are accepted **only** from the paired chat; **create** is rate-limited,
and all lifecycle commands are idempotent per Telegram update id and audited (no
tokens or prompts are logged).
For an automated proof of the wire path without a real bot, see
`packages/coding-agent/scripts/g011-daemon-path-smoke.ts` (real native control
endpoint + loopback WebSocket).
