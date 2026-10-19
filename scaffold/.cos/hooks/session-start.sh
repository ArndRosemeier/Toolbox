#!/usr/bin/env bash
# session-start: inject the handoff and the one-line status.
# Called by the user-level dispatcher; no-ops when the project has no contract.
set -u
root="${CLAUDE_PROJECT_DIR:-$PWD}"
helper="$root/scripts/cos-hook.mjs"
[ -f "$helper" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
exec node "$helper" session-start
