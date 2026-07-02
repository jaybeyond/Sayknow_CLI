#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: harness-tmux-owner-start.sh <session-name> <workspace> [issue-or-pr] [branch-label] [base]

Starts a SKC harness control-plane session with its RuntimeOwner resident inside tmux.
Use this for harness/RPC dogfooding when the owner process must remain operator-visible.

Env:
  SKC_HARNESS_STATE_ROOT  default: ~/.local/state/skc-harness-tmux/<session-name>
  tmux server: default tmux server
USAGE
}

if [[ $# -lt 2 ]]; then usage; exit 2; fi

session_name="$1"
workspace="$2"
issue_or_pr_raw="${3:-}"
branch_label_arg="${4:-}"
base="${5:-dev}"

if [[ ! -d "$workspace" ]]; then
  echo "workspace_not_found:$workspace" >&2
  exit 1
fi
if ! git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "workspace_not_git:$workspace" >&2
  exit 1
fi

actual_branch="$(git -C "$workspace" rev-parse --abbrev-ref HEAD)"
if [[ "$actual_branch" == "HEAD" ]]; then
  echo "workspace_detached_head:$workspace" >&2
  exit 1
fi

branch_label="${branch_label_arg:-$actual_branch}"
if [[ "$branch_label" != "$actual_branch" ]]; then
  cat >&2 <<MSG
branch_label_mismatch: helper branch label must match workspace checkout
  workspace: $workspace
  actual_branch: $actual_branch
  branch_label: $branch_label
Fix: checkout/create the dedicated worktree branch first, or omit [branch-label].
MSG
  exit 1
fi

issue_or_pr="$(node -e 'const raw=process.argv[1]||""; const m=raw.match(/(?:#|PR-|pr-|issue-|Issue-|issues\/|pull\/)?(\d+)$/) || raw.match(/#(\d+)/); process.stdout.write(m ? m[1] : raw)' "$issue_or_pr_raw")"

root="${SKC_HARNESS_STATE_ROOT:-$HOME/.local/state/skc-harness-tmux/$session_name}"
sid="h-tmux-${session_name}-$(date +%s)"
mkdir -p "$root"

input="$(node -e 'const [workspace, branch, base, issueOrPr, sessionId] = process.argv.slice(1); process.stdout.write(JSON.stringify({harness:"sayknow-cli",workspace,branch,base,issueOrPr: issueOrPr || undefined,sessionId,detach:false}))' "$workspace" "$branch_label" "$base" "$issue_or_pr" "$sid")"
(
  cd "$workspace"
  SKC_HARNESS_STATE_ROOT="$root" skc harness start --input "$input" --json
) >"/tmp/${session_name}.skc-start.json"

tmux kill-session -t "$session_name" 2>/dev/null || true
tmux new-session -d -s "$session_name" -n owner
cmd="cd '$workspace' && export SKC_HARNESS_STATE_ROOT='$root' && echo 'SKC tmux owner starting: $sid' && skc harness __owner --session '$sid'"
tmux send-keys -t "$session_name":0.0 -l -- "$cmd"
tmux send-keys -t "$session_name":0.0 Enter

for _ in $(seq 1 30); do
  if SKC_HARNESS_STATE_ROOT="$root" skc harness observe --session "$sid" --json >"/tmp/${session_name}.skc-observe.json" 2>/dev/null; then
    if node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(j.state?.ownerLive ? 0 : 1)' "/tmp/${session_name}.skc-observe.json"; then
      break
    fi
  fi
  sleep 0.5
done

cat "/tmp/${session_name}.skc-start.json"
cat "/tmp/${session_name}.skc-observe.json"
printf '\nSESSION_ID=%s\nSTATE_ROOT=%s\nTMUX_SERVER=default\nTMUX_SESSION=%s\n' "$sid" "$root" "$session_name"
printf 'MONITOR_CAPTURE=tmux capture-pane -p -J -t %q:0.0 -S -200\n' "$session_name"
