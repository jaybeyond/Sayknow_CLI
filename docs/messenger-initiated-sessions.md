# Messenger-Initiated Sessions — Future Work

Status: **backlog / not started** · Recorded 2026-10-19 · No code exists for this yet.

Goal: let the operator start and drive real coding work from a phone messenger
(Discord, Slack, Telegram) while the PC is on, without first opening an `skc`
session at the PC. The PC still does all the work; the phone is only where
instructions go in and results come out.

## What exists today

SKC already attaches a **running** PC-side session to a messenger. It cannot
create a session from the messenger side.

| Capability | Where |
|---|---|
| Discord / Slack / Telegram adapters | `packages/coding-agent/src/sdk/bus/discord-*`, `slack-*`, `telegram-*`; `packages/telegram-remote` |
| One running session ↔ one Discord thread | `sdk/bus/discord-conversation.ts` (`discordConversationKey`, `acceptsDiscordInbound`) |
| Write-ahead delivery journal with an `uncertain` state | `sdk/bus/chat-effect-journal.ts` (`pending` → `leased` → `accepted` / `uncertain` / `terminal`) |
| Long-running chat daemon | `sdk/bus/chat-daemon-runtime.ts`, `skc daemon` |
| Session broker | `packages/coding-agent/src/sdk/broker` |
| Setup | `skc notify setup discord|slack|telegram` ([discord](discord-onboarding.md), [slack](slack-onboarding.md), [telegram](telegram-onboarding.md)) |
| Phone steering wheel design (read + one-line submit to existing sessions) | [`sayknow-remote.md`](sayknow-remote.md) |

The current authority rule from [`sayknow-remote.md`](sayknow-remote.md) is that
the PC remains the authority for file edits, shell execution, and approval
gates; the phone observes and submits to sessions the PC already started.

## The gap

| | Today (SKC) | This proposal |
|---|---|---|
| Session the messenger talks to | A session already running in a PC terminal | A session the daemon creates for that conversation |
| Start new work from the phone | No | Yes, by sending a DM |
| PC requirement | `skc` session open | Daemon running, PC on and online |

This is a change to the authority rule above: a messenger message would be able
to cause shell execution on the PC without anyone at the PC. It needs an
explicit design decision (ADR) before implementation.

## Proposed shape

1. **Conversation-keyed sessions.** The daemon maps each accepted conversation
   (`platform/kind/conversationId`) to one SKC session and an epoch. `/new`
   increments that conversation's epoch and binds the next message to a fresh
   session, leaving other conversations untouched. Session creation must be
   idempotent on (daemon instance, conversation key, epoch) so a crash during
   creation retries instead of duplicating.
2. **Per-conversation mailbox.** If a turn is running, an inbound message is
   steered into it; if idle, it starts the next turn. Messages are durable until
   a turn takes them.
3. **Dedicated workspace.** Messenger-created sessions run in a configured
   workspace directory, not in whatever directory the PC user last used.
4. **Reuse the existing delivery journal.** Replies go through
   `chat-effect-journal.ts`; an uncertain send is re-sent and visibly labelled
   as a possible duplicate rather than silently dropped.

## Safety requirements (must ship with the feature, not after)

1. **Owner-only by default.** DMs from anyone other than configured owner IDs
   are ignored. Group channels require a real mention and are closed unless
   explicitly opened.
2. **Approval gates for destructive actions.** commit, push, deploy, delete,
   and restart require an explicit approval reply from an owner in the
   messenger; no silent auto-approval.
3. **Mandatory outbound secret redaction.** Every outbound chat message and
   progress label passes a secret filter that configuration cannot disable:
   known credential formats (`sk-ant-`, `sk-`, `ghp_`/`github_pat_`, `AKIA`,
   `xox*`, JWTs, PEM keys, `Bearer` tokens) and exact values of secret-named
   environment variables become `[REDACTED:<kind>]`.
   - Today's `notifications.redact` (`sdk/bus/config.ts`, `buildRedactedAction`)
     is different: it is opt-in (default `false`) and drops summaries/streams
     wholesale rather than filtering secrets out of messages that are sent.
   - This item is independent of the rest of the proposal and is the
     lowest-risk piece to implement first, for existing notifications too.
4. **Bot-loop limits.** A rolling per-conversation rate limit on bot-authored
   turns so two agents in one channel cannot loop indefinitely.
5. **Account compromise model.** Document that a compromised messenger account
   equals remote command execution within the gates above.

## Optional follow-ups

- Scheduled / event monitors that give the agent its own turns (for example a
  daily self-check), delivered to a configured conversation.
- Human-readable Markdown memory per conversation under the daemon home.

These only make sense once messenger-initiated sessions exist.

## Suggested order

1. Mandatory outbound secret redaction (safety item 3) for existing
   notification surfaces.
2. ADR: change the PC-authority rule for messenger-initiated sessions, with the
   safety requirements above as acceptance criteria.
3. Conversation-keyed session creation + `/new` epochs + owner-only gate.
4. Approval gates over the messenger.
5. Optional monitors and memory.

## Reference and licensing

The idea comes from reviewing
[`Yeachan-Heo/gajae-way`](https://github.com/Yeachan-Heo/gajae-way), a gateway
that hosts `gjc` agent sessions behind Discord/Slack/Telegram. It is licensed
**AGPL-3.0**; SKC packages are MIT. Use it as a design reference only — do not
copy its code into this repository.

## Non-goals

- Editing code on the phone or rendering full diffs there.
- A remote shell or remote desktop.
- Running work while the PC is off (no cloud execution).
