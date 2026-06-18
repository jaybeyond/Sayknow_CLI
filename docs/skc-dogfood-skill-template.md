# SKC dogfood local skill template

Issue #93 requested a gaebal-sayknow/operator dogfood skill. The live issue has no comment approving a fifth bundled default workflow skill, so this stays a local template instead of changing the default workflow surface. Operators can copy it into a user or project override when they want SKC-first session guidance:

```sh
mkdir -p ~/.skc/skills/skc-dogfood
cp docs/skc-dogfood-skill-template.md ~/.skc/skills/skc-dogfood/SKILL.md
```

For a single project, copy it to `<project>/.skc/skills/skc-dogfood/SKILL.md` instead. Do not commit that project `.skc` copy unless the project explicitly wants a local override.

---
name: skc-dogfood
description: Use when running or reviewing work through SKC sessions, dogfooding Sayknow-CLI, or migrating an operator workflow from OMX to SKC.
---

# SKC Dogfood Operator Workflow

Use SKC first for coding, review, planning, and follow-up sessions. Treat OMX as a fallback only when SKC is unavailable, broken, or missing a required capability.

## Locate and launch SKC

- Installed CLI: run `command -v skc` and then launch with `skc --tmux`.
- Repository checkout: from the sayknow-cli repo, prefer `bun packages/coding-agent/src/cli.ts --tmux` when testing source changes before install.
- Worktree isolation: for branch-specific work, either let SKC create a managed sibling worktree with `skc --tmux --worktree <branch-like-name>` or `cd <existing-worktree-path>` and run `skc --tmux` there. Do not pass filesystem paths to `--worktree`.
- Name sessions explicitly with the project and issue, for example `sayknow-cli-93-dogfood-skill`, so tmux panes, logs, and exports remain traceable.

## Start the session

- Put git operations inside the SKC session: fetch, branch/worktree setup, focused commits, pushes, and PR creation should be visible in-session.
- Submit the initial prompt with the issue URL, target branch, acceptance criteria, verification limits, and any existing plan/spec link.
- Verify the prompt was accepted: the TUI should show the user prompt, an active assistant turn, or a tool/action request. If the session silently idles, resend once with a shorter prompt and capture the failure.
- Verify working state before leaving the session unattended: confirm the target cwd/worktree, branch, and issue scope are visible in the transcript or command output.

## During work

- Keep session names and branch names issue-scoped.
- Prefer SKC workflow skills only when they fit: `deep-interview` for unclear requirements, `ralplan` for planning, `ultragoal` for durable ledgers, and `team` for coordinated tmux execution.
- Keep evidence in the session: issue reads, focused tests/checks, screenshots only when visual behavior matters, and PR URLs.
- When SKC is weaker than OMX, finish the urgent work with the smallest safe fallback and file a sayknow-cli follow-up issue with the missing capability, exact command/session context, expected behavior, and evidence.

## Fallback policy

Use OMX or another operator path only when:

- `skc` cannot be located or launched after checking installed and repo-local commands;
- authentication, model routing, tmux, or prompt submission is broken;
- SKC lacks a required capability that OMX already has;
- an urgent production/review deadline would be missed by debugging SKC first.

Record the fallback reason and create or link the sayknow-cli issue that would make SKC sufficient next time.

## Evidence checklist

Report:

- project, issue, branch/worktree, and session name;
- whether SKC was installed or repo-local;
- prompt acceptance and working-state evidence;
- git operations performed in-session;
- focused verification commands and results;
- PR/issue URLs;
- follow-up sayknow-cli issues for any SKC gap or fallback.
