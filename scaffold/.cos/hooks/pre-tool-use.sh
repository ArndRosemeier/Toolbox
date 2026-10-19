#!/usr/bin/env bash
# pre-tool-use: deny a write outside the worktree(s) the dispatcher recorded.
# No-ops when .cos/worktrees is absent (no dispatch in flight).
set -u
root="${CLAUDE_PROJECT_DIR:-$PWD}"
helper="$root/scripts/cos-hook.mjs"
[ -f "$helper" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
exec node "$helper" pre-tool-use
