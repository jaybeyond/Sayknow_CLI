# gitlab

> Create and inspect GitLab merge requests and pipelines through the GitLab CLI (`glab`).

## Source
- Entry: `packages/coding-agent/src/tools/gitlab.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/gitlab.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/git.ts` — `gitlab` namespace: non-interactive `glab` spawn, JSON parsing, error cleanup.

## Availability
- Registered only when `glab` is on `PATH` (`GitlabTool.createIf`).
- Callable only when the `gitlab.enabled` setting is `true` (default `false`). The tool is `discoverable`.
- Works with gitlab.com and any self-hosted instance that `glab auth login` has a token for. The host comes from the checkout's git remote or from `repo`.

## Inputs

| Field | Type | Used by | Description |
| --- | --- | --- | --- |
| `op` | `"mr_create" \| "mr_view" \| "mr_list" \| "ci_status"` | all | Dispatch selector. |
| `repo` | `string` | all | `OWNER/REPO`, `GROUP/NAMESPACE/REPO`, or project URL; passed as `--repo`. Defaults to the current checkout. |
| `mr` | `string` | `mr_view`, `ci_status` | `mr_view`: iid, URL, or source branch (default: the current branch's MR). `ci_status`: merge request iid (digits only). |
| `title` | `string` | `mr_create` | Required unless `fill` is `true`. |
| `description` | `string` | `mr_create` | Markdown. Omitted means `--description ""` so glab never prompts. |
| `source` | `string` | `mr_create`, `mr_list` | Source branch. `mr_create` defaults to the current branch and fails on a detached HEAD. |
| `target` | `string` | `mr_create`, `mr_list` | Target branch. `mr_create` omits it so glab uses the project default. |
| `draft` | `boolean` | `mr_create` | `--draft`. |
| `fill` | `boolean` | `mr_create` | `--fill`; mutually exclusive with `title`/`description`. glab also pushes the branch. |
| `push` | `boolean` | `mr_create` | `--push` (ignored with `fill`, which already pushes). |
| `reviewer`, `assignee`, `label` | `string[]` | `mr_create` (`label` also `mr_list`) | Repeated flags; blank entries are dropped. |
| `removeSourceBranch`, `squash` | `boolean` | `mr_create` | `--remove-source-branch=<bool>`, `--squash-before-merge=<bool>`. |
| `state` | `"opened" \| "merged" \| "closed" \| "all"` | `mr_list` | Default `opened`. |
| `branch` | `string` | `ci_status` | Pipeline branch (default: current branch). |
| `limit` | `number` | `mr_list` | Default 10, clamped to 1..50. |

## Behaviour
- `mr_create` first runs `glab mr list --source-branch <source> [--target-branch <target>] --output json`. If an `opened` MR exists, it is returned with `created: false` and nothing is created. Otherwise it runs `glab mr create --yes ...`, takes the `/-/merge_requests/<iid>` URL from the output (error if none), and fetches `glab mr view <iid> --output json` for the summary (best effort).
- `mr_view` renders state, draft flag, branches, author, reviewers, labels, `detailed_merge_status`, conflicts, head pipeline, and the description (truncated at 4000 chars).
- `ci_status` runs `glab ci get --output json [--branch|--merge-request]` and lists jobs as `[status] stage/name (failure_reason)`. "No pipeline found" is a normal `# No pipeline` result, not an error.
- Every `glab` call runs with `stdin` closed and `NO_COLOR=1`, `GLAB_NO_PROMPT=1`, `GLAB_CHECK_UPDATE=false`, `GLAB_SEND_TELEMETRY=false`. JSON parsing skips notices glab prints on stdout before the payload. Error banners are reduced to one line; authentication failures point to `glab auth login`.

## Outputs
One text block; `details` carries `{ op, url?, iid?, created? }` and the result `sourceUrl` is the MR or pipeline URL when known.

## Not supported
- MR checkout, merge, approve, and comments. Use `bash` with `glab` for those.
- Live pipeline watching (`ci_status` is a single snapshot).
