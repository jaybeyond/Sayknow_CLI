GitLab CLI tool with a single op-based dispatch. Wraps `glab` (gitlab.com and self-hosted instances that `glab auth login` knows) for merge requests and pipeline status.

<instruction>
Pick the operation via `op`. Each op uses a subset of the parameters. `repo` (OWNER/REPO, GROUP/NAMESPACE/REPO, or project URL) defaults to the current checkout's GitLab remote.
- `mr_create` — Create a merge request. Provide `title` (and optional `description`) or set `fill: true` to fill both from commits. `fill` also pushes the source branch. Optional `source` (defaults to the current branch), `target` (defaults to the project default branch), `draft`, `push` (push the source branch first; needed when it is not on the remote yet), `reviewer[]`, `assignee[]`, `label[]`, `removeSourceBranch`, `squash`. If an open merge request already exists for the same source (and target), it is returned and nothing is created.
- `mr_view` — Read one merge request. Optional `mr` (iid, URL, or source branch; defaults to the current branch's MR). Returns state, branches, merge status, conflicts, head pipeline, and description.
- `mr_list` — List merge requests. Optional `state` (`opened` default, `merged`, `closed`, `all`), `source`, `target`, `label[]`, `limit` (max 50).
- `ci_status` — Latest pipeline status with its jobs. Optional `branch` (defaults to the current branch) or `mr` (merge request iid). Reports "No pipeline" instead of failing when none exists.
</instruction>

<output>
Returns a readable summary for the chosen op (merge request metadata, list entries with URLs, or pipeline jobs).
</output>
