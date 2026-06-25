#!/usr/bin/env bash
# Create a durable, operator-visible SKC tmux session and optionally register it with a router.
#
# Usage:
#   create.sh <session-name> <worktree-path> [channel-id] [mention]
#
# Optional env:
#   SKC_BIN                       path to skc (default: command -v skc)
#   SKC_SESSION_FLAGS             extra flags passed to interactive skc
#   SKC_SESSION_STALE_MINUTES     router stale window (default: 60)
#   SKC_SESSION_KEYWORDS          comma-separated router watch keywords
#   SKC_SESSION_ROUTER            router binary (default: clawhip, if present)
#   SKC_SESSION_SKIP_ROUTER=1     skip router watch registration

set -euo pipefail

SESSION="${1:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
WORKDIR="${2:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
CHANNEL="${3:-}"
MENTION="${4:-}"
SKC_BIN="${SKC_BIN:-$(command -v skc || true)}"
SKC_FLAGS="${SKC_SESSION_FLAGS:-}"
ROUTER_BIN="${SKC_SESSION_ROUTER:-$(command -v clawhip || true)}"
TMUX_CMD=(tmux)

if [[ -z "$SKC_BIN" ]]; then
  echo "skc not found in PATH; set SKC_BIN" >&2
  exit 1
fi
if [[ ! -d "$WORKDIR" ]]; then
  echo "directory not found: $WORKDIR" >&2
  exit 1
fi
if ! git -C "$WORKDIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not a git worktree: $WORKDIR" >&2
  exit 1
fi

BRANCH="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  echo "could not determine branch/worktree name for: $WORKDIR" >&2
  exit 1
fi

if "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

# Keep a shell after SKC exits so crashes/completions remain inspectable.
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -c "$WORKDIR" -n skc \
  "bash -lc 'cd \"$WORKDIR\"; echo \"[skc-session] session=$SESSION branch=$BRANCH cwd=$WORKDIR\"; \"$SKC_BIN\" $SKC_FLAGS; rc=\$?; echo; echo \"[skc-session] SKC exited with status \$rc\"; echo \"[skc-session] pane preserved for postmortem; press Ctrl-D to close\"; exec bash -l'"

"${TMUX_CMD[@]}" set-option -t "$SESSION" remain-on-exit on >/dev/null 2>&1 || true

# Optional Clawhip-style router registration. Private channel ids/mentions stay caller-owned.
if [[ "${SKC_SESSION_SKIP_ROUTER:-0}" != "1" && -n "$ROUTER_BIN" ]]; then
  STALE_MINUTES="${SKC_SESSION_STALE_MINUTES:-60}"
  KEYWORDS="${SKC_SESSION_KEYWORDS:-/skill:deep-interview,/skill:ralplan,skc ultragoal,skc team,deep-interview,ralplan,ultragoal,team,Ask 1 questions,Ask questions,Deep Interview · Round,Question}"
  WATCH_ARGS=(tmux watch --session "$SESSION" --stale-minutes "$STALE_MINUTES" --format compact)
  [[ -n "$KEYWORDS" ]] && WATCH_ARGS+=(--keywords "$KEYWORDS")
  [[ -n "$CHANNEL" ]] && WATCH_ARGS+=(--channel "$CHANNEL")
  [[ -n "$MENTION" ]] && WATCH_ARGS+=(--mention "$MENTION")
  set +e
  timeout 10s "$ROUTER_BIN" "${WATCH_ARGS[@]}"
  watch_rc=$?
  set -e
  if [[ "$watch_rc" -ne 0 && "$watch_rc" -ne 124 ]]; then
    echo "router watch registration failed for $SESSION (rc=$watch_rc); tmux session is still running" >&2
  fi
fi

sleep 2
if ! "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "SKC session vanished immediately after launch: $SESSION" >&2
  exit 1
fi
if ! "${TMUX_CMD[@]}" list-panes -t "$SESSION" -F '#{pane_pid} #{pane_current_command}' >/dev/null 2>&1; then
  echo "SKC session has no readable panes after launch: $SESSION" >&2
  exit 1
fi

echo "created SKC session: $SESSION"
echo "  workdir: $WORKDIR"
echo "  branch:  $BRANCH"
echo "  tail:    $(dirname "$0")/tail.sh $SESSION"
echo "  prompt:  $(dirname "$0")/prompt.sh $SESSION @/path/to/prompt.md"
