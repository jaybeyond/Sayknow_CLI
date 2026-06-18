#!/usr/bin/env bash
# sync-upstream.sh — regenerate the Sayknow-CLI fork onto a new upstream release.
#
#   bun run sync <upstream-tag>     e.g.  bun run sync v0.5.5
#
# Produces a generated tree in a temp worktree and runs verification gates.
# It does NOT auto-commit onto sayknow-fork — you review, then adopt (see runbook).
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: bun run sync <upstream-tag>   (e.g. v0.5.5)" >&2
  exit 2
fi
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"

echo "▸ fetching upstream $TAG"
git fetch upstream --tags --quiet
git rev-parse "$TAG^{commit}" >/dev/null 2>&1 || { echo "unknown tag: $TAG" >&2; exit 1; }

WT="$(mktemp -d)/skc-$TAG"
cleanup() { git worktree remove --force "$WT" 2>/dev/null || true; git worktree prune; }
trap cleanup EXIT
echo "▸ clean upstream worktree → $WT"
git worktree add -q --detach "$WT" "$TAG"

echo "▸ generating fork tree"
bun scripts/gen-tree.ts "$WT" --build

echo
echo "═══ GATES ═══"
fail=0

# G1 — no residual legacy brand tokens (lockfiles excluded: integrity hashes).
echo -n "G1 residual-tokens … "
if grep -rIE 'gajae|robogjc|red-claw|blue-crab|crabShell|\bcan1357\b|Yeachan-Heo' "$WT" \
     --include='*.ts' --include='*.json' --include='*.md' --include='*.toml' --include='*.rs' --include='*.py' \
     --exclude-dir=node_modules 2>/dev/null | grep -vq 'REBRANDING_PLAN'; then
  echo "FAIL"; grep -rIE 'gajae|robogjc|red-claw|blue-crab' "$WT" --include='*.ts' --exclude-dir=node_modules | head -3; fail=1
else echo "ok"; fi

# G2 — codemod idempotence: a SECOND apply changes nothing (diff-based, never hit-count).
echo -n "G2 idempotence … "
SNAP="$(mktemp -d)/snap"; cp -R "$WT" "$SNAP"
bun scripts/apply-rebrand.ts "$WT" --apply >/dev/null 2>&1
if diff -rq "$SNAP" "$WT" -x .git >/dev/null 2>&1; then echo "ok"; else echo "FAIL (second apply changed files)"; fail=1; fi
rm -rf "$SNAP"

# G3 — typecheck.
echo -n "G3 typecheck … "
if (cd "$WT" && bun --cwd=packages/coding-agent run check:types) >/dev/null 2>&1; then echo "ok"; else echo "FAIL"; fail=1; fi

# G4 — brand/i18n/welcome tests.
echo -n "G4 brand+i18n tests … "
if (cd "$WT" && bun test packages/coding-agent/test/i18n.test.ts \
       packages/coding-agent/test/modes/components/redesigned-shell.test.ts \
       packages/coding-agent/test/skc-ui-redesign.test.ts) >/dev/null 2>&1; then echo "ok"; else echo "FAIL"; fail=1; fi

echo "═════════════"
if [[ "$fail" -ne 0 ]]; then
  echo "✗ gates failed for $TAG — inspect $WT (and any .rej files), fix patches/overlay, re-run." >&2
  trap - EXIT  # keep the worktree for inspection
  echo "  worktree kept at: $WT"
  exit 1
fi
echo "✓ $TAG generated and verified at: $WT"
echo "  Review it, then adopt (see docs/FORK_MAINTENANCE.md)."
trap - EXIT
echo "  (worktree kept for adoption: $WT)"
