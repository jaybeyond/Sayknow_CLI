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
#   SKC_SESSION_STATE_DIR         durable metadata/log root (default: <worktree>/.skc-session-state/<session>)
#   SKC_SESSION_TMUX_BIN          tmux-compatible binary (default: tmux)
#   SKC_SESSION_MONITOR_INTERVAL  seconds between vanished-session checks (default: 5)
#   SKC_SESSION_MONITOR_DISABLE=1 disable external vanished-session monitor

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=postmortem.sh
source "$SCRIPT_DIR/postmortem.sh"

SESSION="${1:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
WORKDIR="${2:?Usage: $0 <session-name> <worktree-path> [channel-id] [mention]}"
CHANNEL="${3:-}"
MENTION="${4:-}"
SKC_BIN="${SKC_BIN:-$(command -v skc || true)}"
SKC_FLAGS="${SKC_SESSION_FLAGS:-}"
ROUTER_BIN="${SKC_SESSION_ROUTER:-$(command -v clawhip || true)}"
TMUX_BIN="${SKC_SESSION_TMUX_BIN:-tmux}"
TMUX_CMD=("$TMUX_BIN")
TURN_EVIDENCE_PATTERN="${SKC_SESSION_TURN_EVIDENCE_PATTERN:-Working|Tool|Running|Executing|function call|tool call}"

has_turn_evidence() {
  [[ -s "$STATE_DIR/pane.log" ]] && grep -Eiq "$TURN_EVIDENCE_PATTERN" "$STATE_DIR/pane.log"
}


json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])'
}

shell_join() {
  printf '%q ' "$@"
}

show_recovery_hint() {
  echo "durable metadata: $STATE_DIR/metadata.json" >&2
  echo "durable pane log: $STATE_DIR/pane.log" >&2
  echo "durable events: $STATE_DIR/events.log" >&2
  echo "durable final status: $STATE_DIR/final.json" >&2
  echo "durable vanished status: $STATE_DIR/vanished.json" >&2
  echo "durable runtime state: $RUNTIME_STATE_JSON" >&2
  if [[ -s "$STATE_DIR/pane.log" ]]; then
    echo "durable pane log tail omitted from diagnostics to preserve public-safe boundaries" >&2
  fi
}

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

STATE_DIR="${SKC_SESSION_STATE_DIR:-$WORKDIR/.skc-session-state/$SESSION}"
RUNTIME_STATE_JSON="$STATE_DIR/runtime-state.json"
mkdir -p "$STATE_DIR"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WORKTREE_BASELINE_DIRTY="$(skc_session_git_dirty_boolean "$WORKDIR")"
{
  printf '{\n'
  printf '  "session": "%s",\n' "$(printf '%s' "$SESSION" | json_escape)"
  printf '  "workdir": "%s",\n' "$(printf '%s' "$WORKDIR" | json_escape)"
  printf '  "branch": "%s",\n' "$(printf '%s' "$BRANCH" | json_escape)"
  printf '  "createdAt": "%s",\n' "$CREATED_AT"
  printf '  "skcBin": "%s",\n' "$(printf '%s' "$SKC_BIN" | json_escape)"
  printf '  "stateDir": "%s",\n' "$(printf '%s' "$STATE_DIR" | json_escape)"
  printf '  "paneLog": "%s",\n' "$(printf '%s' "$STATE_DIR/pane.log" | json_escape)"
  printf '  "eventsLog": "%s",\n' "$(printf '%s' "$STATE_DIR/events.log" | json_escape)"
  printf '  "finalStatus": "%s",\n' "$(printf '%s' "$STATE_DIR/final.json" | json_escape)"
  printf '  "runtimeState": "%s",\n' "$(printf '%s' "$RUNTIME_STATE_JSON" | json_escape)"
  printf '  "vanishedStatus": "%s",\n' "$(printf '%s' "$STATE_DIR/vanished.json" | json_escape)"
  printf '  "promptAcceptedStatus": "%s",\n' "$(printf '%s' "$STATE_DIR/prompt-accepted.json" | json_escape)"
  printf '  "worktreeBaselineDirty": %s\n' "$WORKTREE_BASELINE_DIRTY"
  printf '}\n'
} >"$STATE_DIR/metadata.json"
: >"$STATE_DIR/pane.log"
: >"$STATE_DIR/events.log"
printf '[%s] create requested session=%s workdir=%s branch=%s\n' "$CREATED_AT" "$SESSION" "$WORKDIR" "$BRANCH" >>"$STATE_DIR/events.log"
cat >"$STATE_DIR/runner.sh" <<'RUNNER'
#!/usr/bin/env bash
set +e
skc_session_git_dirty_boolean() {
  local workdir="${1:-}"
  if [[ -z "$workdir" ]]; then
    printf 'null\n'
    return 0
  fi
  if ! git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'null\n'
    return 0
  fi
  if [[ -n "$(git -C "$workdir" status --porcelain 2>/dev/null)" ]]; then
    printf 'true\n'
  else
    printf 'false\n'
  fi
}
cd "$SKC_SESSION_WORKDIR" || exit 127
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[%s] runner started session=%s branch=%s cwd=%s\n' "$started_at" "$SKC_SESSION_NAME" "$SKC_SESSION_BRANCH" "$SKC_SESSION_WORKDIR" >>"$SKC_SESSION_EVENTS_LOG"
echo "[skc-session] session=$SKC_SESSION_NAME branch=$SKC_SESSION_BRANCH cwd=$SKC_SESSION_WORKDIR"
echo "[skc-session] durable state=$SKC_SESSION_STATE_DIR"
echo "[skc-session] durable pane log=$SKC_SESSION_PANE_LOG"
echo "[skc-session] durable runtime state=$SKC_COORDINATOR_SESSION_STATE_FILE"
"$SKC_SESSION_SKC_BIN" $SKC_SESSION_FLAGS
rc=$?
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[%s] skc exited status=%s\n' "$finished_at" "$rc" >>"$SKC_SESSION_EVENTS_LOG"
turn_evidence=false
if [[ -s "$SKC_SESSION_PANE_LOG" ]] && grep -Eiq "$SKC_SESSION_TURN_EVIDENCE_PATTERN" "$SKC_SESSION_PANE_LOG"; then
  turn_evidence=true
fi
prompt_accepted=false
for _ in $(seq 1 20); do
  if [[ -s "${SKC_SESSION_PROMPT_ACCEPTED_JSON:-}" ]]; then
    prompt_accepted=true
    break
  fi
  [[ "$turn_evidence" == "true" ]] || break
  sleep 0.1
done
worktree_baseline_dirty="${SKC_SESSION_WORKTREE_BASELINE_DIRTY:-null}"
if [[ "$prompt_accepted" == "true" && -s "${SKC_SESSION_PROMPT_ACCEPTED_JSON:-}" ]]; then
  prompt_baseline="$(python3 - "$SKC_SESSION_PROMPT_ACCEPTED_JSON" <<'PY' 2>/dev/null || true
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        value = json.load(handle).get("worktreeBaselineDirty")
    print("true" if value is True else "false" if value is False else "null")
except Exception:
    print("null")
PY
)"
  if [[ "$prompt_baseline" == "true" || "$prompt_baseline" == "false" ]]; then
    worktree_baseline_dirty="$prompt_baseline"
  fi
fi
worktree_current_dirty="$(skc_session_git_dirty_boolean "${SKC_SESSION_WORKDIR:-}")"
worktree_changed_since_baseline=false
if [[ "$worktree_baseline_dirty" == "false" && "$worktree_current_dirty" == "true" ]]; then
  worktree_changed_since_baseline=true
fi
python3 - "$SKC_SESSION_FINAL_JSON" "$SKC_SESSION_NAME" "$rc" "$started_at" "$finished_at" "$SKC_SESSION_PANE_LOG" "$SKC_COORDINATOR_SESSION_STATE_FILE" "$turn_evidence" "$prompt_accepted" "$SKC_SESSION_WORKDIR" "$worktree_baseline_dirty" "$worktree_current_dirty" "$worktree_changed_since_baseline" <<'PY'
import json
import os
import sys

(
    path,
    session,
    status,
    started_at,
    finished_at,
    pane_log,
    runtime_state,
    turn_evidence,
    prompt_accepted,
    expected_cwd,
    baseline_dirty,
    current_dirty,
    changed_since_baseline,
) = sys.argv[1:]

turn_evidence_present = turn_evidence == "true"
prompt_accepted_present = prompt_accepted == "true"

runtime_summary = {
    "present": False,
    "valid": False,
    "state": None,
    "source": None,
    "event": None,
    "reason": None,
    "terminal": False,
    "terminalState": None,
    "terminalSource": None,
    "finalResponsePresent": False,
    "previousRuntimeState": None,
    "sessionMatches": True,
    "cwdMatches": True,
}
if runtime_state and os.path.exists(runtime_state) and os.path.getsize(runtime_state) > 0:
    runtime_summary["present"] = True
    try:
        with open(runtime_state, encoding="utf-8") as handle:
            runtime_payload = json.load(handle)
        final_response = runtime_payload.get("final_response")
        final_response_present = False
        final_response_source = None
        if isinstance(final_response, dict):
            text = final_response.get("text")
            artifact_path = final_response.get("artifact_path")
            final_response_present = (
                (isinstance(text, str) and text.strip() != "")
                or (isinstance(artifact_path, str) and artifact_path.strip() != "")
            )
            if isinstance(final_response.get("source"), str):
                final_response_source = final_response["source"]
        runtime_state_value = runtime_payload.get("state")
        session_id = runtime_payload.get("session_id")
        cwd = runtime_payload.get("cwd") or runtime_payload.get("workdir")
        session_matches = not session_id or session_id == session
        cwd_matches = not cwd or os.path.abspath(str(cwd)) == os.path.abspath(expected_cwd)
        terminal = runtime_state_value in ("completed", "errored") and session_matches and cwd_matches
        runtime_source = runtime_payload.get("source") if isinstance(runtime_payload.get("source"), str) else None
        runtime_summary.update(
            {
                "valid": True,
                "state": runtime_state_value if isinstance(runtime_state_value, str) else None,
                "source": runtime_source,
                "event": runtime_payload.get("event") if isinstance(runtime_payload.get("event"), str) else None,
                "reason": runtime_payload.get("reason") if isinstance(runtime_payload.get("reason"), str) else None,
                "terminal": terminal,
                "terminalState": runtime_state_value if terminal and isinstance(runtime_state_value, str) else None,
                "terminalSource": final_response_source or runtime_source or ("runtime_state" if terminal else None),
                "finalResponsePresent": final_response_present,
                "previousRuntimeState": runtime_payload.get("previous_runtime_state")
                if isinstance(runtime_payload.get("previous_runtime_state"), str)
                else None,
                "sessionMatches": session_matches,
                "cwdMatches": cwd_matches,
            }
        )
    except Exception:
        runtime_summary["valid"] = False

owner_exit_reason = "normal_exit"
owner_exit_severity = "normal"
runtime_state_value = runtime_summary["state"]
runtime_matches = runtime_summary["valid"] and runtime_summary["sessionMatches"] and runtime_summary["cwdMatches"]

if runtime_matches and runtime_summary["source"] == "process_postmortem":
    owner_exit_reason = runtime_summary["reason"] or "process_postmortem"
    owner_exit_severity = "failure"
elif runtime_summary["terminal"]:
    owner_exit_reason = "terminal_runtime_cleanup"
    owner_exit_severity = "normal"
elif not turn_evidence_present:
    owner_exit_reason = "owner_exited_before_turn_evidence"
    owner_exit_severity = "failure"
elif runtime_matches and runtime_state_value in ("running", "needs_user_input"):
    owner_exit_reason = "owner_exited_after_runtime_acknowledgement_before_terminal_status"
    owner_exit_severity = "failure"
elif prompt_accepted_present and changed_since_baseline == "true":
    owner_exit_reason = "accepted_prompt_observed_recoverable_worktree_changes"
    owner_exit_severity = "failure"
elif prompt_accepted_present and current_dirty == "true":
    owner_exit_reason = "accepted_prompt_dirty_worktree_observed_without_new_change_proof"
    owner_exit_severity = "failure"
elif prompt_accepted_present:
    owner_exit_reason = "accepted_prompt_no_useful_output"
    owner_exit_severity = "failure"
else:
    owner_exit_reason = "owner_exited_before_prompt_acceptance"
    owner_exit_severity = "failure"

runtime_summary["ownerExitReason"] = owner_exit_reason
runtime_summary["severity"] = owner_exit_severity
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "session": session,
            "status": int(status),
            "startedAt": started_at,
            "finishedAt": finished_at,
            "paneLog": pane_log,
            "runtimeState": runtime_state,
            "turnEvidencePresent": turn_evidence_present,
            "promptAccepted": prompt_accepted_present,
            "ownerExitReason": owner_exit_reason,
            "severity": owner_exit_severity,
            "runtimeTerminal": runtime_summary["terminal"],
            "runtimeTerminalState": runtime_summary["terminalState"],
            "runtimeTerminalSource": runtime_summary["terminalSource"],
            "worktreeBaselineDirty": None if baseline_dirty == "null" else baseline_dirty == "true",
            "observedRecoverableWorktreeChanges": current_dirty == "true",
            "worktreeChangedSinceBaseline": changed_since_baseline == "true",
            "runtimeStateSummary": runtime_summary,
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
echo
echo "[skc-session] SKC exited with status $rc"
echo "[skc-session] final status: $SKC_SESSION_FINAL_JSON"
echo "[skc-session] pane preserved for postmortem; press Ctrl-C to release hold"
trap 'exit 0' INT TERM
while true; do
  sleep 3600
done
RUNNER
chmod +x "$STATE_DIR/runner.sh"
cat >"$STATE_DIR/monitor.sh" <<'MONITOR'
#!/usr/bin/env bash
set +e
# shellcheck source=postmortem.sh
source "${SKC_SESSION_POSTMORTEM_SH:?}"
interval="${SKC_SESSION_MONITOR_INTERVAL:-5}"
case "$interval" in
  ''|*[!0-9]*) interval=5 ;;
esac
if [[ "$interval" -lt 1 ]]; then
  interval=1
fi
printf '[%s] monitor started session=%s interval=%ss\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SKC_SESSION_NAME" "$interval" >>"$SKC_SESSION_EVENTS_LOG"
while true; do
  sleep "$interval"
  if "$SKC_SESSION_TMUX_BIN" has-session -t "$SKC_SESSION_NAME" >/dev/null 2>&1; then
    continue
  fi
  detected_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  final_present=false
  [[ -s "$SKC_SESSION_FINAL_JSON" ]] && final_present=true
  final_severity=""
  final_prompt_accepted=false
  if [[ "$final_present" == "true" ]]; then
    final_summary="$(python3 - "$SKC_SESSION_FINAL_JSON" <<'PY' 2>/dev/null || true
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}
print(data.get("severity") or "")
print("true" if data.get("promptAccepted") is True else "false")
PY
)"
    final_severity="$(printf '%s\n' "$final_summary" | sed -n '1p')"
    final_prompt_accepted="$(printf '%s\n' "$final_summary" | sed -n '2p')"
  fi
  runtime_terminal_state=""
  runtime_terminal_source=""
  runtime_terminal_reason=""
  if [[ -s "${SKC_COORDINATOR_SESSION_STATE_FILE:-}" ]]; then
    runtime_summary="$(python3 - "$SKC_COORDINATOR_SESSION_STATE_FILE" "$SKC_SESSION_NAME" "$SKC_SESSION_WORKDIR" <<'PY' 2>/dev/null || true
import json
import os
import sys
state_file, expected_session, expected_cwd = sys.argv[1:]
try:
    with open(state_file, encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}
state = data.get("state")
session_id = data.get("session_id")
cwd = data.get("cwd") or data.get("workdir")
final_response = data.get("final_response") if isinstance(data.get("final_response"), dict) else {}
source = final_response.get("source") or data.get("source")
reason = data.get("reason") if isinstance(data.get("reason"), str) else ""
session_matches = not session_id or session_id == expected_session
cwd_matches = not cwd or os.path.abspath(str(cwd)) == os.path.abspath(expected_cwd)
if state in {"completed", "errored"} and session_matches and cwd_matches:
    print(state)
    print(source or "runtime_state")
    print(reason)
else:
    print("")
    print("")
PY
)"
    runtime_terminal_state="$(printf '%s\n' "$runtime_summary" | sed -n '1p')"
    runtime_terminal_source="$(printf '%s\n' "$runtime_summary" | sed -n '2p')"
    runtime_terminal_reason="$(printf '%s\n' "$runtime_summary" | sed -n '3p')"
  fi
  if [[ "$final_present" != "true" && -n "$runtime_terminal_state" && "$runtime_terminal_source" != "process_postmortem" ]]; then
    printf '[%s] tmux session closed after terminal runtime state=%s source=%s; no vanished failure marker written\n' "$detected_at" "$runtime_terminal_state" "${runtime_terminal_source:-unknown}" >>"$SKC_SESSION_EVENTS_LOG"
    exit 0
  fi
  if [[ "$final_present" == "true" ]]; then
    if [[ "$final_severity" != "failure" ]]; then
      printf '[%s] tmux session closed after final status severity=%s; no vanished failure marker written\n' "$detected_at" "${final_severity:-unknown}" >>"$SKC_SESSION_EVENTS_LOG"
      exit 0
    fi
    printf '[%s] tmux session missing after failure final; preserving vanished marker too\n' "$detected_at" >>"$SKC_SESSION_EVENTS_LOG"
  fi
  prompt_accepted=false
  if [[ -s "${SKC_SESSION_PROMPT_ACCEPTED_JSON:-}" || "$final_prompt_accepted" == "true" ]]; then
    prompt_accepted=true
  fi
  tui_ready=false
  if [[ -s "$SKC_SESSION_PANE_LOG" ]] && grep -Eq 'Sayknow forge|Type your message|> Type your message|Working' "$SKC_SESSION_PANE_LOG"; then
    tui_ready=true
  fi
  vanish_phase="before_tui_readiness"
  vanish_reason="tmux_session_missing_before_tui_readiness"
  if [[ "$prompt_accepted" == "true" ]]; then
    vanish_phase="after_prompt_acceptance"
    vanish_reason="tmux_session_missing_after_prompt_acceptance"
    if [[ "$final_present" == "true" ]]; then
      vanish_reason="tmux_session_missing_after_prompt_acceptance_failure_final"
    fi
  elif [[ "$tui_ready" == "true" ]]; then
    vanish_phase="before_prompt_acceptance"
    vanish_reason="tmux_session_missing_before_prompt_acceptance"
  fi
  if [[ "$final_present" != "true" && -n "$runtime_terminal_state" && "$runtime_terminal_source" == "process_postmortem" ]]; then
    vanish_phase="process_postmortem"
    vanish_reason="${runtime_terminal_reason:-process_postmortem}"
  fi
  severity="failure"
  printf '[%s] tmux session vanished final_present=%s final_severity=%s prompt_accepted=%s tui_ready=%s phase=%s severity=%s reason=%s\n' "$detected_at" "$final_present" "${final_severity:-none}" "$prompt_accepted" "$tui_ready" "$vanish_phase" "$severity" "$vanish_reason" >>"$SKC_SESSION_EVENTS_LOG"
  skc_session_write_vanished_json \
    "$SKC_SESSION_VANISHED_JSON" \
    "$SKC_SESSION_NAME" \
    "$SKC_SESSION_WORKDIR" \
    "$vanish_reason" \
    "$vanish_phase" \
    "$severity" \
    "$prompt_accepted" \
    "$final_present" \
    "$tui_ready" \
    "$SKC_SESSION_PANE_LOG" \
    "$SKC_SESSION_EVENTS_LOG" \
    "$SKC_SESSION_FINAL_JSON" \
    "$SKC_COORDINATOR_SESSION_STATE_FILE" \
    "${SKC_SESSION_PROMPT_ACCEPTED_JSON:-}"
  if [[ "$severity" == "failure" && -n "${SKC_SESSION_ROUTER_BIN:-}" && -n "${SKC_SESSION_CHANNEL:-}" ]]; then
    "$SKC_SESSION_ROUTER_BIN" tmux stale \
      --session "$SKC_SESSION_NAME" \
      --pane "missing" \
      --minutes 0 \
      --last-line "SKC tmux session vanished before final status; see $SKC_SESSION_VANISHED_JSON" \
      --channel "$SKC_SESSION_CHANNEL" >/dev/null 2>&1 || true
  fi
  exit 0
done
MONITOR
chmod +x "$STATE_DIR/monitor.sh"

if "${TMUX_CMD[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session already exists: $SESSION" >&2
  exit 1
fi

LAUNCH_CMD=(
  env
  "SKC_SESSION_NAME=$SESSION"
  "SKC_SESSION_WORKDIR=$WORKDIR"
  "SKC_SESSION_BRANCH=$BRANCH"
  "SKC_SESSION_STATE_DIR=$STATE_DIR"
  "SKC_SESSION_PANE_LOG=$STATE_DIR/pane.log"
  "SKC_SESSION_EVENTS_LOG=$STATE_DIR/events.log"
  "SKC_SESSION_FINAL_JSON=$STATE_DIR/final.json"
  "SKC_SESSION_VANISHED_JSON=$STATE_DIR/vanished.json"
  "SKC_SESSION_PROMPT_ACCEPTED_JSON=$STATE_DIR/prompt-accepted.json"
  "SKC_COORDINATOR_SESSION_ID=$SESSION"
  "SKC_COORDINATOR_SESSION_STATE_FILE=$RUNTIME_STATE_JSON"
  "SKC_COORDINATOR_SESSION_BRANCH=$BRANCH"
  "SKC_SESSION_TURN_EVIDENCE_PATTERN=$TURN_EVIDENCE_PATTERN"
  "SKC_SESSION_WORKTREE_BASELINE_DIRTY=$WORKTREE_BASELINE_DIRTY"
  "SKC_SESSION_SKC_BIN=$SKC_BIN"
  "SKC_SESSION_FLAGS=$SKC_FLAGS"
  bash "$STATE_DIR/runner.sh"
)
LAUNCH_SHELL="$(shell_join "${LAUNCH_CMD[@]}")"
# Keep a shell after SKC exits so crashes/completions remain inspectable. The runner
# writes normal-exit finalization; pane.log/events.log remain useful if tmux vanishes.
"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -c "$WORKDIR" -n skc "$LAUNCH_SHELL"

"${TMUX_CMD[@]}" set-option -t "$SESSION" remain-on-exit on >/dev/null 2>&1 || true
# Mirror pane output to a durable log so a tmux server/session vanish still leaves recoverable evidence.
"${TMUX_CMD[@]}" pipe-pane -o -t "$SESSION":0.0 "cat >> '$STATE_DIR/pane.log'" >/dev/null 2>&1 || {
  echo "warning: failed to attach durable pane log at $STATE_DIR/pane.log" >&2
}
"${TMUX_CMD[@]}" capture-pane -t "$SESSION":0.0 -p -S -200 >>"$STATE_DIR/pane.log" 2>/dev/null || true
printf '[%s] tmux session launched and pipe attached\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$STATE_DIR/events.log"

if [[ "${SKC_SESSION_MONITOR_DISABLE:-0}" != "1" ]]; then
  MONITOR_CMD=(
    env
    "SKC_SESSION_NAME=$SESSION"
    "SKC_SESSION_WORKDIR=$WORKDIR"
    "SKC_SESSION_BRANCH=$BRANCH"
    "SKC_SESSION_PANE_LOG=$STATE_DIR/pane.log"
    "SKC_SESSION_EVENTS_LOG=$STATE_DIR/events.log"
    "SKC_SESSION_FINAL_JSON=$STATE_DIR/final.json"
    "SKC_SESSION_VANISHED_JSON=$STATE_DIR/vanished.json"
    "SKC_SESSION_PROMPT_ACCEPTED_JSON=$STATE_DIR/prompt-accepted.json"
    "SKC_COORDINATOR_SESSION_STATE_FILE=$RUNTIME_STATE_JSON"
    "SKC_SESSION_TMUX_BIN=$TMUX_BIN"
    "SKC_SESSION_POSTMORTEM_SH=$SCRIPT_DIR/postmortem.sh"
    "SKC_SESSION_MONITOR_INTERVAL=${SKC_SESSION_MONITOR_INTERVAL:-5}"
    "SKC_SESSION_ROUTER_BIN=$ROUTER_BIN"
    "SKC_SESSION_CHANNEL=$CHANNEL"
    "SKC_SESSION_TURN_EVIDENCE_PATTERN=$TURN_EVIDENCE_PATTERN"
    "SKC_SESSION_WORKTREE_BASELINE_DIRTY=$WORKTREE_BASELINE_DIRTY"
    bash "$STATE_DIR/monitor.sh"
  )
  nohup "${MONITOR_CMD[@]}" >>"$STATE_DIR/monitor.log" 2>&1 &
  MONITOR_PID=$!
  printf '%s\n' "$MONITOR_PID" >"$STATE_DIR/monitor.pid"
  printf '[%s] monitor launched pid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MONITOR_PID" >>"$STATE_DIR/events.log"
fi

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
  show_recovery_hint
  exit 1
fi
if ! has_turn_evidence; then
  for _ in $(seq 1 20); do
    [[ -s "$STATE_DIR/final.json" ]] && break
    sleep 0.1
  done
fi
final_severity=""
if [[ -s "$STATE_DIR/final.json" ]]; then
  final_severity="$(python3 - "$STATE_DIR/final.json" <<'PY' 2>/dev/null || true
import json
import sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        print(json.load(handle).get("severity") or "")
except Exception:
    print("")
PY
)"
fi
if [[ -s "$STATE_DIR/final.json" && "$final_severity" == "failure" ]] && ! has_turn_evidence; then
  echo "SKC owner exited before durable turn evidence: $SESSION" >&2
  show_recovery_hint
  exit 1
fi
if ! "${TMUX_CMD[@]}" list-panes -t "$SESSION" -F '#{pane_pid} #{pane_current_command}' >"$STATE_DIR/panes.txt" 2>/dev/null; then
  echo "SKC session has no readable panes after launch: $SESSION" >&2
  show_recovery_hint
  exit 1
fi

echo "created SKC session: $SESSION"
echo "  workdir: $WORKDIR"
echo "  branch:  $BRANCH"
echo "  state:   $STATE_DIR"
echo "  log:     $STATE_DIR/pane.log"
echo "  events:  $STATE_DIR/events.log"
echo "  final:   $STATE_DIR/final.json"
echo "  runtime: $RUNTIME_STATE_JSON"
echo "  vanish:  $STATE_DIR/vanished.json"
echo "  tail:    $(dirname "$0")/tail.sh $SESSION"
echo "  prompt:  $(dirname "$0")/prompt.sh $SESSION @/path/to/prompt.md"
