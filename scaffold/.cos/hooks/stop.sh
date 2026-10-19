#!/usr/bin/env bash
# stop: force one step when the last commit has no gate run in the journal.
# Self-limiting: one forced step per sha, recorded in .cos/.stop-guard.
set -u
root="${CLAUDE_PROJECT_DIR:-$PWD}"
helper="$root/scripts/cos-hook.mjs"
[ -f "$helper" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
exec node "$helper" stop
