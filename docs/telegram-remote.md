# Telegram Remote — control skc sessions from your phone

Telegram Remote is a **tiny, safe operator remote** for Sayknow-CLI (`skc`)
sessions. It lets you list, observe, start, and stop sessions from a Telegram
chat — a control button, not a remote shell or cockpit. The real session owner
stays on your machine (skc/tmux); Telegram only issues bounded, allowlisted
commands over the Coordinator MCP.

The gateway implementation lives in
[`packages/telegram-remote`](../packages/telegram-remote/README.md); this guide
covers how to turn it on and use it.

## What you get

Two backends, selected by `telegram.backend`:

- **`coordinator`** (default) — multi-session lifecycle + observation. Bot
  commands: `/sessions`, `/observe <id>`, `/start-session <preset> [task]`,
  `/stop <id>`, `/help`.
- **`rpc`** — attach/detach keyboard for one persistent `skc launch --output rpc`
  session. Bot commands: `/attach`, `/detach`, `/status`, `/abort`, `/help`.

Anything outside this vocabulary is rejected as unknown.

## Quick start (skc settings)

1. **Create a bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot`,
   copy the token (`123456:AA...`).
2. **Find your Telegram id.** Message [@userinfobot](https://t.me/userinfobot)
   (or read it from your bot's `getUpdates`). You need your numeric user id
   and/or chat id.
3. **Configure skc.** Open `skc`, go to **Settings → Integrations**, and set:
   - **Telegram Remote** (`telegram.enabled`) → on
   - **Bot Token** (`telegram.botToken`) → the @BotFather token
   - **Allowed User IDs** (`telegram.allowedUserIds`) → your id
     (comma-separated; or **Allowed Chat IDs**). At least one allowlist is
     required — unlisted senders are refused with no hints.
   - **Session Presets** (`telegram.presets`) → JSON array of approved presets
     (see below) if you want `/start-session`.

   Settings persist to your skc config; you can also edit them directly in
   `config.yml` under the `telegram.*` keys.

4. **Start the gateway.**

   ```sh
   skc telegram start     # start with current settings
   skc telegram status    # show whether it is configured / running
   skc telegram env        # print the SKC_TELEGRAM_REMOTE_* env it would use
   ```

   When `telegram.enabled` is on, skc also **auto-starts** the gateway in the
   background (PID-tracked, detached) the next time you launch an interactive
   session, so `skc telegram start` is only needed for a manual/one-off start.

5. **Use it from Telegram.** Send `/help` to your bot, then `/sessions`,
   `/observe <id>`, `/start-session <preset>`, `/stop <id>` (coordinator mode).

### Presets (`/start-session`)

Session creation is **preset-only** — no workdir/command/branch ever comes from
chat. A preset binds a fixed workdir + session command + an optional task
template with a single length-capped `{{task}}` slot:

```json
[
  {
    "id": "proj",
    "workdir": "/home/you/src/project",
    "sessionCommand": "skc --worktree",
    "taskTemplate": "Use /skill:ralplan to plan: {{task}}",
    "taskMaxLen": 2000
  }
]
```

`/start-session proj fix the flaky auth test` starts the `proj` preset with the
task substituted into the template.

## RPC mode (one persistent session)

Set **Backend** (`telegram.backend`) → `rpc` to attach to a single existing
owner-only socket exposed by `skc launch --output rpc --listen <socket>`. The
gateway never spawns, kills, or tears down that session — it is only a Telegram
attach/detach remote keyboard. RPC mode requires **RPC Socket**
(`telegram.rpcSocket`) and **State Directory** (`telegram.stateDir`) for
reconnect/resync. Agent questions and gates render as inline buttons;
turn-complete delivery sends the final assistant text (HTML-escaped, chunked to
Telegram's 4096-byte limit).

## Safety properties

- **Default deny.** Only allowlisted Telegram user/chat ids may issue any
  command; unlisted senders get an identical boring refusal.
- **Preset-only creation.** No raw workdir/command/branch/shell/RPC from chat.
- **Forced-minimal mutations.** The coordinator runs with the smallest mutation
  set — `sessions` (read + start), plus `reports` only when `/stop` is enabled
  (**Enable /stop**, `telegram.enableStop`). `questions` is never enabled.
- **Redaction by construction.** Only a typed projection (session id, derived
  name, bounded status/turn enums, branch, timestamps, short sanitized blocker)
  ever leaves the machine. Raw tmux tail, transcripts, tool IO, diffs, file
  contents, env, prompts, and tokens are never transmitted.
- **`/stop` confirmation.** `/stop <id>` arms; a second `/stop <id> confirm` (or
  the inline **Confirm stop** button) records a graceful coordinator
  `cancelled`. It does not kill a tmux process.

## Rich messaging & push (optional)

- **Rich Messages** (`telegram.enableRich`, default on) — HTML formatting +
  inline **Observe/Stop/Refresh** buttons. Set off for plain text.
- **Register Bot Menu** (`telegram.registerCommands`, default on) — registers
  the Bot command menu at startup.
- **Push Notifications** (`telegram.enablePush`) — Follow/Mute subscriptions via
  the coordinator event-watch surface (needs a state dir). Push never widens the
  transmitted-data allowlist.

## Settings ↔ environment

The `skc telegram` command and autostart translate `telegram.*` settings into
`SKC_TELEGRAM_REMOTE_*` environment variables consumed by the gateway (see
`skc telegram env`). You can also run the gateway standalone with those env vars
directly — see [`packages/telegram-remote/README.md`](../packages/telegram-remote/README.md)
for the full variable list, `.env.example`, and turnkey **systemd**/**launchd**
service examples for always-on deployment.

## Non-goals

Telegram Remote is not a remote RPC cockpit, remote shell, config editor, or
transcript viewer. It is a bounded lifecycle + observation button. For richer
control, use skc directly on the host.
