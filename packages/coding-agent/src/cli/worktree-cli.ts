/**
 * Tombstone for the removed legacy worktree cleanup API.
 *
 * The recursive-deletion implementation that previously lived here
 * (`listWorktrees`/`clearWorktrees`) was deliberately removed and does not
 * come back through this subpath. This module exists only to fail imports
 * with actionable migration guidance.
 */
export {};

throw new Error(
	"@sayknow-cli/coding-agent/cli/worktree-cli was deliberately removed: the legacy worktree cleanup API (listWorktrees/clearWorktrees) is gone. Inspect leftover managed worktrees under ~/.skc/wt manually and use `git worktree remove` or `git worktree prune` instead.",
);
