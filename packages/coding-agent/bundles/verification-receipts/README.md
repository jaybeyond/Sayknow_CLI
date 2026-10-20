# verification-receipts

SKC plugin bundle that closes the loop after delegated work (`task`, `subagent`, `job`):

- Hooks record a delegation gate when a background `task` starts and observe it finishing. They never block
  and never alter results; they only append a short advisory text to the tool result.
- `verification_run` runs 1-32 explicit test files and stores an immutable, private, freshness-bound receipt.
- `verification_status` recomputes a receipt's freshness without rerunning anything.
- `verification_loop` (no parameters) rechecks every gate of the current session and lists closed gap kinds
  with the actions that resolve them. Verdict: `clean`, `gaps` or `blocked`.

It is advisory. `clean` means a mechanical recheck passed, not that the change is correct.

## Install (checkout only)

The bundle is not published to npm. From a checkout:

```sh
skc plugin install packages/coding-agent/bundles/verification-receipts --user
skc plugin list --json
```

Installs copy only the declared files, so the launch and reminder texts are inline constants in
`hooks/verification-gate.ts` (a declared exception to the repository's prompt-file rule, D9).

## Decisions and limits (D1-D9)

| # | Limit |
|---|---|
| D1 | Runners: `bun-test` (default) and `node-test`. Node is taken from `PATH` and must be `>= 24.11.1` (the first release line whose JUnit reporter emits `<testcase file>`). **Node 22 and older are unsupported**: `node-test` returns `unavailable/invalid_node_version`. The parser is strict; anything unexpected is `incomplete/invalid_report`. `node-test` runs one `node --test` process per file (see Tests and freshness); `timeoutMs` is the budget of the whole run. |
| D2 | No model-based advisory in v1. |
| D3 | User scope only. A `--project` install loads, but tools return `store_unavailable/project_scope_unsupported`, the loop is `blocked`, and hooks write nothing. |
| D4 | Hooks: `tool_call`/`task`/before (HEAD baseline) and `tool_result` for `task`, `subagent`, `job`. Resumed and queued-resume subagents and unknown running task jobs also open gates. |
| D5 | Lives in `packages/coding-agent/bundles/verification-receipts/`; checkout install only. |
| D6 | The loop reads the transcript through the read-only session facade with a bounded `getLeafId()`/`getEntry()` walk (20000 entries or 5 s). It never calls `getBranch()`. |
| D7 | Scope is the current session (`predecessor_session_not_scanned` warns when the session has a parent). |
| D8 | POSIX only (macOS, Linux). Windows reports `platform_unsupported`. |
| D9 | Prompt texts are inline constants, see Install. |

## Storage

Under `<agentDir>/skc-plugin-data/verification-receipts` (directories `0700`, files `0600`, `O_NOFOLLOW`,
symlinks fail closed): `receipts/`, `events/`, `ledger/`, `journal/`. Files hold digests, enum values, counts,
epoch milliseconds and (in receipts) the selected test file paths: no raw ids, test output or source text. A symlinked or group/other-writable
data directory is refused with `unsafe_permissions`.

Hooks are lock-free and fail open. If an event cannot be written they leave a `DROP` marker, and a full event
directory leaves an `OVERFLOW` marker. The loop reconciles markers by re-walking the transcript. Overflow is
sticky: if more than 64 gates are open, extra gates are kept as pending keys; if even the pending-key list
overflows, or a gate was launched off the current branch, the session stays `gaps` with `gate_state_dropped`.
Start a new session to reset it.

## Tests and freshness

- Run files are validated (no globs, no `..`, no symlinks, no `.git`/`.skc`/`node_modules` segments) and passed
  to the runner as `./relative` paths.
- Results are attributed per selected file. A file that did not execute (or only skipped tests) gives
  `incomplete/selected_input_not_executed`; only `passed` receipts cover anything.
- bun applies the repository's `bunfig.toml`. A test file matched by `test.pathIgnorePatterns` is skipped by
  bun with exit 0 and is detected through attribution, never reported as passed.
- Freshness binds HEAD, the index, every dirty or flagged (`skip-worktree`, `assume-unchanged`) file, and the
  selected inputs. **Gitignored source files that are not selected inputs are not part of the fingerprint**
  (for example generated code); receipts list this under `limitations`.
- Sparse checkouts: `skip-worktree` paths are folded into the dirty set, so a checkout with more than 5000 of
  them always fingerprints as `unavailable/file_limit` (receipts list this under `limitations`).
- A receipt is `fresh` only if the fingerprint before and after the run is identical and still equal now.
- Every git call runs at the repository toplevel (resolved with `rev-parse --show-toplevel`), so a session started
  in a subdirectory fingerprints and covers the whole repository with toplevel-relative paths. Git calls pin
  `core.fsmonitor=false`, `core.trustctime=true`, `core.checkStat=default`, `core.ignoreStat=false`,
  `core.untrackedCache=false`, `core.fileMode=true`, `core.symlinks=true` and `core.ignorecase=false`, and the
  dirty-file frame includes the file mode. Repository config therefore cannot turn off the stat, mode, symlink or
  case-exact comparison that `git status` makes. **`core.fileMode=true` is fail-closed on filesystems without
  trustworthy exec bits (FAT/exFAT, some network mounts):** files whose mode git sees differently from the index
  count as dirty and a large tree can reach `unavailable/file_limit`. Likewise `core.ignorecase=false` on a
  case-insensitive filesystem reports a tracked file whose on-disk name case differs from the index as changed.
- **Clean/smudge filters.** A clean filter rewrites file content before `git status` compares it, so an edit can be
  invisible to every status-based check. If repository-controlled config (local, worktree, an `include.path` file)
  defines any `filter.<name>.clean` or `filter.<name>.process` other than the stock git-lfs drivers
  (`git-lfs clean [--] %f`, `git-lfs filter-process [--skip]` under the name `lfs`), the fingerprint is
  `unavailable/unsupported_config` and no receipt can be fresh. Filters from global or system config are the
  user's own and are not examined, so a globally installed git-lfs keeps working. The check needs git >= 2.26
  (`--show-scope`); an older git is `unavailable/git_unavailable`.
- **Built-in check-in conversions.** `text`/`eol` attributes, `core.autocrlf`/`core.eol`, `ident`,
  `working-tree-encoding` and `core.attributesFile` also convert content before `git status` compares it, so a
  same-size raw edit (for example moving a CRLF, or editing inside an expanded `$Id: ... $`) can leave `git status`
  empty. These cannot be told apart from filters by config, so they are not rejected. Instead the dirty set also
  contains every tracked path that `git diff-files --name-only -z` lists, and the frame hashes those paths' raw bytes
  and mode. `diff-files` compares stat data only (size, mtime, ctime, inode, mode) with the pinned config, writes
  no index and runs no conversion. Such paths count toward the 5000-path and byte limits. Limits of this defence:
  - **D-7 (accepted deviation from plan principle 1).** The defence only works while the index still holds the old
    stat data. Any index refresh — a plain `git status`, `git diff`, `git add`, `git update-index --refresh`, or
    SKC itself running `git status` — records the new stat for a conversion-hidden edit, after which neither
    `git status` nor `diff-files` lists the path and the fingerprint is unchanged. Such an edit can then be
    reported `fresh` (and a later delegation `no_change`) although a rerun would fail. Hashing the raw bytes of
    every converted path would close this, but with a repository-wide `* text=auto` it would make every fingerprint
    `unavailable/file_limit`, so it is not done. Do not rely on receipts for tests whose result depends on raw
    line endings, `$Id$` expansion or working-tree encoding; rerun them.
  - an edit that keeps size, mtime, ctime and inode of the indexed entry is not seen by stat, and an edit made within
    the same clock second as the last index write ("racily clean") is compared by converted content by git itself;
  - a path that was touched without a content change stays listed until the index is refreshed, so a receipt can be
    reported `stale` or `changed_during_run` without a real edit (conservative).
- Known uncovered sources (not an exhaustive guarantee) are D-7 above and the gitignored-source and sparse-checkout
  limits; receipts list them under `limitations`.
- `node-test` runs **one process per file** and reads each file's JUnit report together with node's own totals.
  node's JUnit tree is lossy: a test that has subtests and a `describe` with children are both a `<testsuite>`, and
  a `describe` without children (empty, hook-only, only skipped/todo) is a `<testcase>` that is not a test. Such a
  phantom cannot be told from a leaf test by looking at the XML, and the totals (`tests`, `suites`, `pass`, ...)
  are global to a process. Per file they are exact, so they provide the counts (a test with subtests counts the
  parent and every subtest, as node does) and the XML cross-checks them: each total must appear exactly once,
  `tests = pass + fail + cancelled + skipped + todo`, `tests + suites` must equal the number of `<testcase>` plus
  `<testsuite>` elements, and every testcase must carry the selected file. Anything else is `incomplete/invalid_report`
  (fail closed, also for a future node whose report shape differs). A file with no tests is `no_tests`; in a
  multi-file run it is `incomplete/selected_input_not_executed`. The cost is that files run one after another
  instead of in parallel.
- A queued subagent resume always opens its own `resume:` gate (one per subagent while open), whether the
  earlier job of that subagent is still running, terminal or unknown. It closes only after the resumed run is
  observed terminal.

## Collisions

If another extension already registers a tool named `verification_run` (or the other two), none of this
bundle's tools register and one `session_collision` is reported. The hooks still load.

## Other limits

- A long-running tool call by the runner is killed by process group on timeout or abort. Descendants that
  leave the group with `setsid` are not detected.
- Dirty test files that existed before the delegation make the changed-test set larger (conservative).
- Gates are never removed by time; resolved gates are compacted and the oldest are retired at 128.
- Vocabulary beyond the original plan (all fail closed): `incomplete/output_incomplete` when a runner or git
  output stream did not drain completely, and loop warnings `transcript_entry_unresolved` (the transcript chain
  references an entry that cannot be read; the scan stays truncated), `receipts_unreadable`, and the fingerprint
  reason `unsupported_config` (non-stock repository-local clean/process filter).
- `tools/verification-git.ts` is declared in the manifest as a string-shorthand (subskill-scoped) entry only so the
  installer copies it; the bundle has no subskills, so it never registers as a tool.
- **D-6 (deviation from the plan's AC14).** The host does not reject unknown root keys for the strict tool
  schemas: `validateToolArguments` strips them (and still rejects type and range violations) before `execute` runs.
  The tools therefore guarantee that unknown keys never reach `execute`, not that a call carrying them is refused.
- A launch listing longer than 64 KiB, or with a repeated job id, is a partial job set (model-written task
  descriptions can contain fake listing lines); it needs observed quiescence before the gate can resolve.
- A `job` listing with more than 256 entries, or a task entry that cannot be parsed, never counts as quiescent.
